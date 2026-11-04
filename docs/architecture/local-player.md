# Fusion Player Agent — desktop client specification

> Status: server-side player control plane implemented; Windows desktop client is next  
> Target: Windows 10/11, first release  
> Primary role: local audio playback, local library indexing, Twitch chat connection, OBS routing

## 1. Why a separate local agent

The public site and request queue must remain available even when the streamer's PC is off. Audio playback and OBS capture, however, must happen on the streamer's PC. The desktop agent is therefore a separate component from the cloud web application.

The first release will use an owner-curated local music library as the fallback provider. This avoids extracting audio from YouTube/Spotify or depending on an undocumented third-party API. Only files for which the channel owner has the necessary broadcast rights may be added.

## 2. Desktop technology

- Electron desktop application, TypeScript, Node.js 22.
- Windows-first packaging with an installer and auto-update path.
- Main process handles filesystem access, device authentication, network polling and playback lifecycle.
- Renderer process displays connection state, library folder, current track, volume and diagnostics.
- `contextIsolation: true`, `nodeIntegration: false`; renderer never receives the device token or unrestricted filesystem access.
- Store the device token with Electron `safeStorage` (Windows DPAPI-backed encryption). Never write it to plain-text settings or logs.

Electron is selected because it reuses the project's TypeScript stack and gives us a maintainable Windows UI. Playback output is routed to a dedicated Windows audio device (for example a virtual audio cable) selected by the owner and captured as a separate OBS source.

## 3. Device pairing and authentication

1. The owner signs in to the Fusion Music website through Twitch.
2. The owner creates a one-time pairing token from the owner panel.
3. The owner enters/pastes the token into Fusion Player.
4. The server stores only SHA-256 of the device token; the raw token is shown once and saved encrypted on the PC.
5. Every request from the player uses `Authorization: Bearer <device-token>`.
6. The owner can revoke a device from the website; revoked tokens stop working immediately.

A device token is not a Twitch OAuth token and has no Twitch API permissions. The desktop app never receives the Twitch client secret or refresh token.

## 4. Cloud-to-player protocol

Use durable HTTP polling rather than a long-lived WebSocket for the player command channel. This works with the planned Render deployment and survives ordinary network interruptions.

- Poll pending commands every 2 seconds.
- Send heartbeat every 15 seconds.
- Acknowledge each command with success/failure and an optional short error code.
- Commands are durable rows in PostgreSQL; they are not fire-and-forget in-memory messages.
- The server marks commands delivered and acknowledged. Unacknowledged commands can be retried safely using a command ID.
- Player state includes online/offline, idle/playing/paused/error, current request ID, client version and last heartbeat.
- If the PC is offline, the website continues to accept and show queued requests; playback status is shown as offline.

Initial command vocabulary:
- `play` — play a specific approved library track;
- `pause` / `resume`;
- `skip`;
- `set_volume`;
- `resync_library`.

## 5. Local music library

The owner selects a folder in the desktop app. The agent scans supported audio files and synchronizes only:
- stable file hash (SHA-256);
- title, artist, album (when present);
- duration;
- format and file size;
- optional artwork metadata.

The actual audio file and absolute local path never leave the PC. The server stores only catalog metadata and a provider identifier derived from the hash. A track is playable only if the local agent can resolve that identifier to a file in the approved folder.

The catalog must not accept arbitrary viewer-uploaded files or arbitrary URLs. The owner is responsible for ensuring every file has the rights needed for the Twitch broadcast; owning a personal copy alone does not necessarily grant broadcast rights.

## 6. Twitch chat integration

The local agent will maintain a Twitch EventSub WebSocket connection while online. The server remains responsible for OAuth and token refresh.

- Request only the required broadcaster scopes when the chat integration is implemented (initially `user:read:chat`; add `moderator:read:chatters` only when live-chatter eligibility is enabled).
- The server can issue a short-lived broadcaster access token to the paired local agent over HTTPS; the agent keeps it in memory and requests a fresh one when reconnecting.
- The agent subscribes to `channel.chat.message`, parses `!трек` and `!скип`, and forwards normalized commands to the server.
- Twitch roles are verified server-side; chat badges supplied by a client are not trusted as authorization.
- When the agent is offline, chat commands are unavailable, but the public website and queue remain online.

The chat connection is deliberately part of the local agent in the first release, avoiding a second always-on cloud worker. If the product later needs chat commands while the streamer PC is offline, move the EventSub connection to a dedicated cloud worker.

## 7. OBS audio routing

- Fusion Player outputs audio to a dedicated virtual audio device or explicitly selected output device.
- OBS captures that device as a separate audio source.
- Live stream track includes music.
- VOD track excludes music.
- Local recording behavior is configured separately and tested explicitly.
- The agent exposes a simple audio test tone and meter so the owner can verify routing before going live.

Audio track separation is not a substitute for music rights. The exact Windows device and OBS track settings will be validated on the owner's PC before enabling playback.

## 8. Reliability requirements

- Reconnect with exponential backoff and jitter.
- Persist device identity and settings securely.
- Never lose a command silently; acknowledge or report a failure.
- On startup, reconcile player state with server queue state before accepting playback commands.
- On track completion, report completion once using an idempotent event ID.
- A stale heartbeat changes the website status to offline.
- Log diagnostic codes and timings, but never log bearer tokens, OAuth tokens or absolute paths.
- If a file is missing or its hash no longer matches, mark it unavailable and report a recoverable error rather than skipping silently.

## 9. Implementation order

- [x] Database schema for devices, commands, sessions and idempotent track events.
- [x] Owner-only pairing endpoint; raw device token is shown once and only its hash is stored.
- [x] Bearer-token validation, durable command polling/retry, acknowledgement and heartbeat endpoints.
- [x] Idempotent track lifecycle events (`started`, `finished`, `failed`) that update the server queue.
- [x] Owner dashboard for pairing and revoking the single active player device.
- [ ] Electron shell with pairing and connection status.
- [ ] Local folder scanner and catalog sync.
- [ ] Local audio playback and output-device selection.
- [ ] Twitch EventSub chat integration.
- [ ] OBS routing test and Windows installer.

The server currently supports one active player device per channel. This avoids two computers attempting to play the same queue simultaneously; multi-device failover can be added later with an explicit active-device selection mechanism.
