import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const suffix = `ci-${Date.now()}`;

try {
  await client.query("BEGIN");

  const channel = await client.query(
    "INSERT INTO channels (twitch_broadcaster_id, twitch_login, display_name) VALUES ($1, $2, $3) RETURNING id",
    [suffix, suffix, "CI smoke test"],
  );
  const channelId = channel.rows[0].id;

  const user = await client.query(
    "INSERT INTO users (twitch_user_id, twitch_login, display_name) VALUES ($1, $2, $3) RETURNING id",
    [suffix, suffix, "CI smoke user"],
  );
  const userId = user.rows[0].id;

  await client.query(
    "INSERT INTO channel_settings (channel_id) VALUES ($1)",
    [channelId],
  );
  const initialRights = await client.query(
    "SELECT music_rights_confirmed_at FROM channel_settings WHERE channel_id = $1",
    [channelId],
  );
  if (initialRights.rows[0]?.music_rights_confirmed_at !== null) {
    throw new Error("New channels must start without a music-rights confirmation");
  }
  await client.query(
    `UPDATE channel_settings
     SET music_rights_confirmed_at = NOW(), music_rights_confirmed_by = $2
     WHERE channel_id = $1`,
    [channelId, userId],
  );
  const confirmedRights = await client.query(
    "SELECT music_rights_confirmed_at, music_rights_confirmed_by FROM channel_settings WHERE channel_id = $1",
    [channelId],
  );
  if (!confirmedRights.rows[0]?.music_rights_confirmed_at ||
      confirmedRights.rows[0]?.music_rights_confirmed_by !== userId) {
    throw new Error("Music-rights attestation was not stored correctly");
  }

  await client.query(
    `INSERT INTO service_heartbeats (service_name, status, details)
     VALUES ('ci-smoke', 'connected', '{"source":"smoke-test"}'::jsonb)`,
  );
  const heartbeat = await client.query(
    "SELECT status, details->>'source' AS source FROM service_heartbeats WHERE service_name = 'ci-smoke'",
  );
  if (heartbeat.rows[0]?.status !== "connected" || heartbeat.rows[0]?.source !== "smoke-test") {
    throw new Error("Service heartbeat status was not stored correctly");
  }

  const track = await client.query(
    "INSERT INTO tracks (provider, provider_track_id, title, artist) VALUES ('ci-smoke', $1, 'Smoke test', 'Fusion') RETURNING id",
    [suffix],
  );
  const trackId = track.rows[0].id;

  const request = await client.query(
    "INSERT INTO requests (channel_id, track_id, requester_id, status) VALUES ($1, $2, $3, 'playing') RETURNING id",
    [channelId, trackId, userId],
  );
  const requestId = request.rows[0].id;

  await client.query(
    "INSERT INTO queue_state (channel_id, current_request_id) VALUES ($1, $2)",
    [channelId, requestId],
  );

  const player = await client.query(
    "INSERT INTO player_devices (channel_id, name, token_hash) VALUES ($1, 'CI player', $2) RETURNING id",
    [channelId, `token-hash-${suffix}`],
  );
  const playerId = player.rows[0].id;

  const localHash = createHash("sha256").update(suffix).digest("hex");
  await client.query(
    "UPDATE tracks SET is_available = FALSE WHERE provider = 'local_library'",
  );
  await client.query(
    `INSERT INTO tracks
       (provider, provider_track_id, title, artist, duration_seconds, metadata, is_available, last_seen_at)
     VALUES ('local_library', $1, 'Local smoke track', 'Fusion', 180, $2::jsonb, TRUE, NOW())
     ON CONFLICT (provider, provider_track_id) DO UPDATE SET
       is_available = TRUE, last_seen_at = NOW(), metadata = EXCLUDED.metadata`,
    [localHash, JSON.stringify({ format: "mp3", fileSize: 1024 })],
  );
  await client.query(
    `INSERT INTO player_library_syncs (device_id, channel_id, track_count, total_bytes)
     VALUES ($1, $2, 1, 1024)`,
    [playerId, channelId],
  );
  const libraryTrack = await client.query(
    "SELECT is_available, metadata->>'format' AS format FROM tracks WHERE provider = 'local_library' AND provider_track_id = $1",
    [localHash],
  );
  if (!libraryTrack.rows[0]?.is_available || libraryTrack.rows[0]?.format !== "mp3") {
    throw new Error("Local music library metadata was not stored correctly");
  }

  const localTrackRow = await client.query(
    "SELECT id FROM tracks WHERE provider = 'local_library' AND provider_track_id = $1",
    [localHash],
  );
  const queuedLocalRequest = await client.query(
    "INSERT INTO requests (channel_id, track_id, requester_id, status) VALUES ($1, $2, $3, 'queued') RETURNING id",
    [channelId, localTrackRow.rows[0].id, userId],
  );
  await client.query("UPDATE requests SET status = 'played' WHERE id = $1", [requestId]);
  await client.query(
    "UPDATE queue_state SET current_request_id = NULL WHERE channel_id = $1",
    [channelId],
  );
  await client.query(
    `INSERT INTO player_sessions
       (channel_id, device_id, client_version, status, current_request_id, last_heartbeat_at)
     VALUES ($1, $2, 'ci-smoke', 'online', NULL, NOW())
     ON CONFLICT (device_id) WHERE device_id IS NOT NULL
     DO UPDATE SET status = 'online', current_request_id = NULL, last_heartbeat_at = NOW()`,
    [channelId, playerId],
  );

  const playerReady = await client.query(
    `SELECT pd.id
     FROM player_devices pd
     JOIN player_sessions ps ON ps.device_id = pd.id
     WHERE pd.channel_id = $1
       AND pd.revoked_at IS NULL
       AND ps.last_heartbeat_at > NOW() - INTERVAL '45 seconds'
       AND ps.status IN ('online', 'playing', 'paused')
     LIMIT 1`,
    [channelId],
  );
  const nextLocalTrack = await client.query(
    `SELECT r.id
     FROM requests r
     JOIN tracks t ON t.id = r.track_id
     WHERE r.channel_id = $1 AND r.status = 'queued'
       AND t.provider = 'local_library' AND t.is_available = TRUE
     ORDER BY COALESCE(r.position, 2147483647), r.created_at
     LIMIT 1`,
    [channelId],
  );
  if (!playerReady.rowCount || nextLocalTrack.rows[0]?.id !== queuedLocalRequest.rows[0].id) {
    throw new Error("The local queue did not select the next playable track");
  }
  await client.query(
    `INSERT INTO player_commands (device_id, channel_id, command, payload)
     VALUES ($1, $2, 'play', $3::jsonb)`,
    [playerId, channelId, JSON.stringify({ requestId: nextLocalTrack.rows[0].id })],
  );

  await client.query(
    `UPDATE player_sessions
     SET status = 'playing', current_request_id = $2, last_heartbeat_at = NOW()
     WHERE device_id = $1`,
    [playerId, requestId],
  );

  const command = await client.query(
    `INSERT INTO player_commands (device_id, channel_id, command, payload)
     VALUES ($1, $2, 'skip', '{}'::jsonb) RETURNING id`,
    [playerId, channelId],
  );
  await client.query(
    "UPDATE player_commands SET status = 'delivered', delivered_at = NOW(), attempts = 1 WHERE id = $1",
    [command.rows[0].id],
  );
  await client.query(
    `UPDATE player_commands
     SET status = 'acknowledged', acknowledged_at = NOW()
     WHERE id = $1 AND device_id = $2 AND status = 'delivered'`,
    [command.rows[0].id, playerId],
  );
  const commandStatus = await client.query(
    "SELECT status FROM player_commands WHERE id = $1",
    [command.rows[0].id],
  );
  if (commandStatus.rows[0]?.status !== "acknowledged") {
    throw new Error("Player command delivery/acknowledgement failed");
  }

  const eventId = randomUUID();
  await client.query(
    `INSERT INTO player_events (event_id, device_id, channel_id, request_id, event_type)
     VALUES ($1, $2, $3, $4, 'started') ON CONFLICT DO NOTHING`,
    [eventId, playerId, channelId, requestId],
  );
  await client.query(
    `INSERT INTO player_events (event_id, device_id, channel_id, request_id, event_type)
     VALUES ($1, $2, $3, $4, 'started') ON CONFLICT DO NOTHING`,
    [eventId, playerId, channelId, requestId],
  );
  const eventCount = await client.query(
    "SELECT COUNT(*)::int AS count FROM player_events WHERE event_id = $1",
    [eventId],
  );
  if (eventCount.rows[0].count !== 1) {
    throw new Error("Duplicate player events were not constrained correctly");
  }

  await client.query(
    "INSERT INTO votes (channel_id, request_id, user_id, vote) VALUES ($1, $2, $3, 'skip') ON CONFLICT DO NOTHING",
    [channelId, requestId, userId],
  );
  await client.query(
    "INSERT INTO votes (channel_id, request_id, user_id, vote) VALUES ($1, $2, $3, 'skip') ON CONFLICT DO NOTHING",
    [channelId, requestId, userId],
  );

  const chatEventId = randomUUID();
  const chatEvent = await client.query(
    `INSERT INTO twitch_chat_commands (event_id, channel_id, chatter_user_id, command)
     VALUES ($1, $2, $3, 'track')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [chatEventId, channelId, "ci-chat-user"],
  );
  const duplicateChatEvent = await client.query(
    `INSERT INTO twitch_chat_commands (event_id, channel_id, chatter_user_id, command)
     VALUES ($1, $2, $3, 'track')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [chatEventId, channelId, "ci-chat-user"],
  );
  if (chatEvent.rowCount !== 1 || duplicateChatEvent.rowCount !== 0) {
    throw new Error("Duplicate Twitch chat command events were not idempotent");
  }

  const votes = await client.query(
    "SELECT COUNT(*)::int AS count FROM votes WHERE channel_id = $1 AND request_id = $2",
    [channelId, requestId],
  );
  if (votes.rows[0].count !== 1) {
    throw new Error("Duplicate skip votes were not constrained correctly");
  }

  // Restore the first request to playing so the partial unique index
  // is tested against a genuinely concurrent active track.
  await client.query(
    "UPDATE requests SET status = 'playing' WHERE id = $1",
    [requestId],
  );

  const activePlaying = await client.query(
    "SELECT COUNT(*)::int AS count FROM requests WHERE channel_id = $1 AND status = 'playing'",
    [channelId],
  );
  const uniqueIndex = await client.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'requests_one_playing_per_channel_idx'",
  );
  if (activePlaying.rows[0].count !== 1 || !uniqueIndex.rows[0]?.indexdef?.startsWith("CREATE UNIQUE INDEX")) {
    throw new Error("Partial unique playing-track index is missing or smoke fixture is inconsistent: " + JSON.stringify({
      activePlaying: activePlaying.rows[0].count,
      index: uniqueIndex.rows[0]?.indexdef || null,
    }));
  }

  await client.query("SAVEPOINT unique_playing_test");
  const secondTrack = await client.query(
    "INSERT INTO tracks (provider, provider_track_id, title, artist) VALUES ('ci-smoke', $1, 'Second smoke test', 'Fusion') RETURNING id",
    [`${suffix}-second`],
  );

  let duplicatePlayingBlocked = false;
  try {
    await client.query(
      "INSERT INTO requests (channel_id, track_id, requester_id, status) VALUES ($1, $2, $3, 'playing')",
      [channelId, secondTrack.rows[0].id, userId],
    );
  } catch (error) {
    if (error?.code === "23505") duplicatePlayingBlocked = true;
    else throw error;
  }

  if (!duplicatePlayingBlocked) {
    throw new Error("Database allowed two simultaneously playing tracks for one channel");
  }

  await client.query("ROLLBACK TO SAVEPOINT unique_playing_test");
  await client.query("ROLLBACK");
  console.log("Database smoke checks passed: queue integrity, music rights attestation, worker heartbeat, idempotent chat/player events, local library metadata and player command acknowledgements.");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* connection already failed */ }
  console.error("Database smoke checks failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
