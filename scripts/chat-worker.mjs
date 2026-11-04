import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import { parseChatCommand, normalizeTrackSearch } from "../lib/chat-command.mjs";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const WORKER_LOCK_ID = 1_174_001_903;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TOKEN_ENCRYPTION_KEY) {
  throw new Error("Twitch application credentials and TOKEN_ENCRYPTION_KEY are required");
}
const WebSocketClient = globalThis.WebSocket;
if (!WebSocketClient) {
  throw new Error("Node.js 22 WebSocket support is required");
}

const sslMode = new URL(DATABASE_URL).searchParams.get("sslmode");
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslMode && sslMode !== "disable"
    ? { rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full" }
    : undefined,
});

let lockClient;
let ownerCache = null;
let appAccessToken = null;
let appTokenExpiresAt = 0;
let streamLiveCache = { live: null, viewerCount: null, expiresAt: 0 };
let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let keepaliveTimer = null;
let heartbeatTimer = null;
let currentWorkerStatus = "starting";
let lastMessageAt = Date.now();
let keepaliveTimeoutSeconds = 10;
let stopping = false;
let chatSendQueue = Promise.resolve();
let lastChatSendAt = 0;

function encryptionKey() {
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

function decryptToken(value) {
  const [ivPart, tagPart, encryptedPart] = value.split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Stored Twitch token has an invalid format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

async function updateWorkerStatus(status, details = {}) {
  currentWorkerStatus = status;
  try {
    await pool.query(
      `INSERT INTO service_heartbeats (service_name, status, details, last_heartbeat_at, updated_at)
       VALUES ('twitch-chat', $1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (service_name) DO UPDATE SET
         status = EXCLUDED.status,
         details = EXCLUDED.details,
         last_heartbeat_at = NOW(),
         updated_at = NOW()`,
      [status, JSON.stringify(details)],
    );
  } catch (error) {
    console.error("[fusion-chat] Could not update worker heartbeat:", error.message);
  }
}

async function getOwnerContext(forceRefresh = false) {
  if (
    !forceRefresh &&
    ownerCache &&
    ownerCache.cacheUntil > Date.now() &&
    ownerCache.expiresAt > Date.now() + 120_000
  ) {
    return ownerCache;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT c.id AS channel_id, c.twitch_broadcaster_id,
              u.id AS owner_user_id, tt.access_token_encrypted,
              tt.refresh_token_encrypted, tt.scopes, tt.expires_at
       FROM channels c
       JOIN channel_roles cr ON cr.channel_id = c.id AND cr.role = 'owner'
       JOIN users u ON u.id = cr.user_id AND u.twitch_user_id = c.twitch_broadcaster_id
       JOIN twitch_tokens tt ON tt.user_id = u.id
       ORDER BY c.created_at ASC
       LIMIT 1
       FOR UPDATE OF tt`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("The channel owner has not connected Twitch yet");

    let accessToken = decryptToken(row.access_token_encrypted);
    let refreshToken = decryptToken(row.refresh_token_encrypted);
    let scopes = row.scopes || [];
    let expiresAt = new Date(row.expires_at);

    if (expiresAt.getTime() < Date.now() + 120_000) {
      const response = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: TWITCH_CLIENT_ID,
          client_secret: TWITCH_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),

        cache: "no-store",
      });

      if (!response.ok) throw new Error("Twitch token refresh failed");
      const refreshed = await response.json();
      if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_in) {
        throw new Error("Twitch token refresh response was incomplete");
      }

      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token;
      scopes = refreshed.scope?.length ? refreshed.scope : scopes;
      expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

      await client.query(
        `UPDATE twitch_tokens
         SET access_token_encrypted = $2,
             refresh_token_encrypted = $3,
             scopes = $4,
             expires_at = $5,
             updated_at = NOW()
         WHERE user_id = $1`,
        [
          row.owner_user_id,
          encryptToken(accessToken),
          encryptToken(refreshToken),
          scopes,
          expiresAt,
        ],
      );
    }

    const validationResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: "Bearer " + accessToken },
      signal: AbortSignal.timeout(10_000),

      cache: "no-store",
    });
    if (!validationResponse.ok) {
      throw new Error("Twitch broadcaster authorization is invalid; reconnect Twitch in the dashboard");
    }
    const validation = await validationResponse.json();
    if (validation.user_id !== row.twitch_broadcaster_id) {
      throw new Error("Twitch authorization belongs to a different account; reconnect the channel owner");
    }
    if (Array.isArray(validation.scopes)) {
      const validatedScopes = validation.scopes;
      if (JSON.stringify(validatedScopes) !== JSON.stringify(scopes)) {
        await client.query(
          "UPDATE twitch_tokens SET scopes = $2, updated_at = NOW() WHERE user_id = $1",
          [row.owner_user_id, validatedScopes],
        );
      }
      scopes = validatedScopes;
    }

    const requiredScopes = ["user:read:chat", "user:write:chat", "moderator:read:chatters", "moderation:read"];
    const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length) {
      throw new Error("Reconnect the broadcaster Twitch account and grant: " + missingScopes.join(", "));
    }

    await client.query("COMMIT");
    ownerCache = {
      channelId: row.channel_id,
      broadcasterId: row.twitch_broadcaster_id,
      ownerUserId: row.owner_user_id,
      accessToken,
      scopes,
      expiresAt: expiresAt.getTime(),
      cacheUntil: Date.now() + 20_000,
    };
    return ownerCache;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
async function getAppAccessToken() {
  if (appAccessToken && Date.now() < appTokenExpiresAt - 60_000) {
    return appAccessToken;
  }

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(10_000),

    cache: "no-store",
  });
  if (!response.ok) throw new Error("Twitch app access token request failed");

  const data = await response.json();
  if (!data.access_token || !data.expires_in) {
    throw new Error("Twitch app access token response was incomplete");
  }

  appAccessToken = data.access_token;
  appTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return appAccessToken;
}

async function getLiveViewerCount(owner) {
  if (streamLiveCache.live !== null && streamLiveCache.expiresAt > Date.now()) {
    return streamLiveCache.live ? streamLiveCache.viewerCount : null;
  }

  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_id", owner.broadcasterId);
  const appToken = await getAppAccessToken();
  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + appToken,
      "Client-Id": TWITCH_CLIENT_ID,
    },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Twitch live status lookup failed");

  const data = await response.json();
  const stream = Array.isArray(data.data) ? data.data[0] : null;
  const viewerCount = stream ? Math.max(0, Number(stream.viewer_count) || 0) : null;
  streamLiveCache = {
    live: !!stream,
    viewerCount,
    expiresAt: Date.now() + 10_000,
  };
  return viewerCount;
}

function sendChatMessage(owner, message, replyTo) {
  const task = chatSendQueue.then(async () => {
    const waitMs = Math.max(0, 1_100 - (Date.now() - lastChatSendAt));
    if (waitMs) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const body = {
      broadcaster_id: owner.broadcasterId,
      sender_id: owner.broadcasterId,
      message: String(message).slice(0, 450),
    };
    if (replyTo) body.reply_parent_message_id = replyTo;

    const response = await fetch("https://api.twitch.tv/helix/chat/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + owner.accessToken,
        "Client-Id": TWITCH_CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),

      cache: "no-store",
    });
    lastChatSendAt = Date.now();

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error("Twitch chat reply failed (" + response.status + "): " + detail.slice(0, 250));
    }
  });

  chatSendQueue = task.catch(() => undefined);
  return task;
}

async function ensureUser(client, event) {
  const result = await client.query(
    `INSERT INTO users (twitch_user_id, twitch_login, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (twitch_user_id) DO UPDATE SET
       twitch_login = EXCLUDED.twitch_login,
       display_name = EXCLUDED.display_name,
       updated_at = NOW()
     RETURNING id`,
    [
      event.chatter_user_id,
      event.chatter_user_login || null,
      event.chatter_user_name || event.chatter_user_login || "Twitch viewer",
    ],
  );
  return result.rows[0].id;
}

async function enqueueNextTrack(client, channelId, createdBy) {
  const state = await client.query(
    "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
    [channelId],
  );
  if (!state.rows[0] || state.rows[0].current_request_id) return null;

  const pendingPlay = await client.query(
    `SELECT 1 FROM player_commands
     WHERE channel_id = $1
       AND command = 'play'
       AND created_at > NOW() - INTERVAL '30 seconds'
       AND status IN ('pending', 'delivered', 'acknowledged')
     LIMIT 1`,
    [channelId],
  );
  if (pendingPlay.rowCount) return null;

  const player = await client.query(
    `SELECT pd.id
     FROM player_devices pd
     JOIN player_sessions ps ON ps.device_id = pd.id
     WHERE pd.channel_id = $1
       AND pd.revoked_at IS NULL
       AND ps.last_heartbeat_at > NOW() - INTERVAL '45 seconds'
       AND ps.status IN ('online', 'playing', 'paused')
     ORDER BY ps.last_heartbeat_at DESC
     LIMIT 1
     FOR UPDATE OF pd`,
    [channelId],
  );
  if (!player.rows[0]) return null;

  const next = await client.query(
    `SELECT r.id
     FROM requests r
     JOIN tracks t ON t.id = r.track_id
     WHERE r.channel_id = $1
       AND r.status = 'queued'
       AND t.provider = 'local_library'
       AND t.is_available = TRUE
     ORDER BY COALESCE(r.position, 2147483647), r.created_at
     LIMIT 1
     FOR UPDATE OF r`,
    [channelId],
  );
  if (!next.rows[0]) return null;

  await client.query(
    `INSERT INTO player_commands (device_id, channel_id, created_by, command, payload)
     VALUES ($1, $2, $3, 'play', $4::jsonb)`,
    [player.rows[0].id, channelId, createdBy, JSON.stringify({ requestId: next.rows[0].id })],
  );
  return next.rows[0].id;
}

async function recordCommandEvent(client, owner, eventId, event, command) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2 || ':' || $3))",
    [owner.channelId, event.chatter_user_id, command],
  );
  const recent = await client.query(
    `SELECT 1 FROM twitch_chat_commands
     WHERE channel_id = $1
       AND chatter_user_id = $2
       AND command = $3
       AND created_at > NOW() - INTERVAL '5 seconds'
     LIMIT 1`,
    [owner.channelId, event.chatter_user_id, command],
  );
  const inserted = await client.query(
    `INSERT INTO twitch_chat_commands (event_id, channel_id, chatter_user_id, command)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, owner.channelId, event.chatter_user_id, command],
  );
  return {
    inserted: inserted.rowCount > 0,
    throttled: recent.rowCount > 0,
  };
}

async function handleTrackCommand(owner, event, eventId, searchText) {
  const term = normalizeTrackSearch(searchText);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventRecord = await recordCommandEvent(client, owner, eventId, event, "track");
    if (!eventRecord.inserted) {
      await client.query("ROLLBACK");
      return null;
    }
    if (eventRecord.throttled) {
      await client.query("COMMIT");
      return null;
    }
    if (!term) {
      await client.query("COMMIT");
      return "Использование: !трек название композиции";
    }

    const userId = await ensureUser(client, event);
    const settings = await client.query(
      `SELECT requests_enabled, max_pending_per_user, music_rights_confirmed_at
       FROM channel_settings WHERE channel_id = $1 FOR UPDATE`,
      [owner.channelId],
    );
    const channelSettings = settings.rows[0];
    if (!channelSettings?.requests_enabled || !channelSettings.music_rights_confirmed_at) {
      await client.query("COMMIT");
      return "Приём музыкальных заявок сейчас закрыт.";
    }

    const pattern = "%" + term + "%";
    const matches = await client.query(
      `SELECT id, title, artist
       FROM tracks
       WHERE provider = 'local_library'
         AND is_available = TRUE
         AND (title ILIKE $1 OR artist ILIKE $1 OR (artist || ' - ' || title) ILIKE $1)
       ORDER BY
         CASE WHEN lower(title) = lower($2) THEN 0 ELSE 1 END,
         lower(artist), lower(title)
       LIMIT 4`,
      [pattern, term],
    );

    if (!matches.rowCount) {
      await client.query("COMMIT");
      return "Не нашёл этот трек в музыкальной библиотеке.";
    }
    if (matches.rowCount > 1) {
      const suggestions = matches.rows.slice(0, 3)
        .map((track) => track.artist + " — " + track.title)
        .join("; ");
      await client.query("COMMIT");
      return "Нашёл несколько совпадений: " + suggestions + ". Уточни запрос.";
    }

    const track = matches.rows[0];
    const pendingCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM requests
       WHERE channel_id = $1 AND requester_id = $2
         AND status IN ('pending', 'queued')`,
      [owner.channelId, userId],
    );
    if (pendingCount.rows[0].count >= channelSettings.max_pending_per_user) {
      await client.query("COMMIT");
      return "У тебя уже есть активная заявка в очереди.";
    }

    const duplicate = await client.query(
      `SELECT 1 FROM requests
       WHERE channel_id = $1 AND track_id = $2
         AND status IN ('queued', 'playing')
       LIMIT 1`,
      [owner.channelId, track.id],
    );
    if (duplicate.rowCount) {
      await client.query("COMMIT");
      return "Этот трек уже находится в очереди.";
    }

    await client.query(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [owner.channelId],
    );
    const requestResult = await client.query(
      `INSERT INTO requests (channel_id, track_id, requester_id, status)
       VALUES ($1, $2, $3, 'queued')
       RETURNING id`,
      [owner.channelId, track.id, userId],
    );

    await enqueueNextTrack(client, owner.channelId, userId);
    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'music.request.created.chat', $3::jsonb)`,
      [owner.channelId, userId, JSON.stringify({
        requestId: requestResult.rows[0].id,
        trackId: track.id,
        source: "twitch_chat",
      })],
    );

    await client.query("COMMIT");
    return "Добавил в очередь: " + track.artist + " — " + track.title + ".";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    throw error;
  } finally {
    client.release();
  }
}

async function queueSkipCommand(client, owner, userId, requestId) {
  const device = await client.query(
    "SELECT id FROM player_devices WHERE channel_id = $1 AND revoked_at IS NULL LIMIT 1 FOR UPDATE",
    [owner.channelId],
  );
  if (!device.rows[0]) return false;

  const existing = await client.query(
    `SELECT 1 FROM player_commands
     WHERE device_id = $1
       AND command = 'skip'
       AND payload->>'requestId' = $2
       AND status IN ('pending', 'delivered', 'acknowledged')
     LIMIT 1`,
    [device.rows[0].id, requestId],
  );
  if (!existing.rowCount) {
    await client.query(
      `INSERT INTO player_commands (device_id, channel_id, created_by, command, payload)
       VALUES ($1, $2, $3, 'skip', $4::jsonb)`,
      [device.rows[0].id, owner.channelId, userId, JSON.stringify({ requestId })],
    );
  }
  return true;
}

async function handleSkipCommand(owner, event, eventId) {
  const roleResult = await pool.query(
    `SELECT cr.role
     FROM users u
     LEFT JOIN channel_roles cr ON cr.user_id = u.id AND cr.channel_id = $2
     WHERE u.twitch_user_id = $1
     LIMIT 1`,
    [event.chatter_user_id, owner.channelId],
  );
  const role = roleResult.rows[0]?.role || null;
  const isModerator = role === "owner" || role === "moderator";
  let viewerCount = null;
  if (!isModerator) {
    try {
      viewerCount = await getLiveViewerCount(owner);
      if (viewerCount === null) {
        return "Голосование за пропуск доступно только во время эфира.";
      }
    } catch {
      return "Не удалось проверить количество зрителей. Попробуй ещё раз позже.";
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventRecord = await recordCommandEvent(client, owner, eventId, event, "skip");
    if (!eventRecord.inserted) {
      await client.query("ROLLBACK");
      return null;
    }
    if (eventRecord.throttled) {
      await client.query("COMMIT");
      return null;
    }

    const userId = await ensureUser(client, event);
    const state = await client.query(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [owner.channelId],
    );
    const requestId = state.rows[0]?.current_request_id;
    if (!requestId) {
      await client.query("COMMIT");
      return "Сейчас нет активного трека для пропуска.";
    }

    const current = await client.query(
      "SELECT 1 FROM requests WHERE id = $1 AND channel_id = $2 AND status = 'playing'",
      [requestId, owner.channelId],
    );
    if (!current.rowCount) {
      await client.query("COMMIT");
      return "Трек уже сменился. Обнови очередь.";
    }

    if (isModerator) {
      const queued = await queueSkipCommand(client, owner, userId, requestId);
      await client.query(
        `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
         VALUES ($1, $2, 'music.skip.forced.chat', $3::jsonb)`,
        [owner.channelId, userId, JSON.stringify({ requestId })],
      );
      await client.query("COMMIT");
      return queued ? "Модераторский пропуск отправлен." : "Проигрыватель сейчас не подключён.";
    }

    const settings = await client.query(
      "SELECT skip_vote_percent FROM channel_settings WHERE channel_id = $1",
      [owner.channelId],
    );
    const percent = settings.rows[0]?.skip_vote_percent || 50;
    const inserted = await client.query(
      `INSERT INTO votes (channel_id, request_id, user_id, vote)
       VALUES ($1, $2, $3, 'skip')
       ON CONFLICT (channel_id, request_id, user_id) DO NOTHING
       RETURNING user_id`,
      [owner.channelId, requestId, userId],
    );
    const count = await client.query(
      "SELECT COUNT(*)::int AS count FROM votes WHERE channel_id = $1 AND request_id = $2 AND vote = 'skip'",
      [owner.channelId, requestId],
    );
    const skipVotes = count.rows[0]?.count || 0;
    const threshold = Math.max(1, Math.ceil((viewerCount ?? 0) * percent / 100));
    let commandQueued = false;

    if (skipVotes >= threshold) {
      commandQueued = await queueSkipCommand(client, owner, userId, requestId);
    }

    await client.query("COMMIT");
    if (commandQueued) {
      return "Порог голосования достигнут (" + skipVotes + "/" + threshold + "). Пропускаю трек.";
    }
    if (!inserted.rowCount) {
      return "Твой голос уже учтён (" + skipVotes + "/" + threshold + ").";
    }
    return "Голос за пропуск учтён: " + skipVotes + "/" + threshold + ".";
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    throw error;
  } finally {
    client.release();
  }
}

async function handleNotification(message) {
  const event = message?.payload?.event;
  if (!event || event.broadcaster_user_id !== (await getOwnerContext()).broadcasterId) return;

  const command = parseChatCommand(event.message?.text);
  if (!command) return;

  const eventId = message.metadata?.message_id;
  if (typeof eventId !== "string" || !eventId) return;

  const owner = await getOwnerContext();
  const replyTo = event.message_id || null;

  let reply;
  if (command.command === "track") {
    reply = await handleTrackCommand(owner, event, eventId, command.argument);
  } else {
    reply = await handleSkipCommand(owner, event, eventId);
  }

  if (reply) {
    try {
      await sendChatMessage(owner, reply, replyTo);
    } catch (error) {
      console.error("[fusion-chat] Could not send chat reply:", error.message);
    }
  }
}

async function createSubscription(sessionId) {
  const owner = await getOwnerContext();
  const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + owner.accessToken,
      "Client-Id": TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "channel.chat.message",
      version: "1",
      condition: {
        broadcaster_user_id: owner.broadcasterId,
        user_id: owner.broadcasterId,
      },
      transport: {
        method: "websocket",
        session_id: sessionId,
      },
    }),
    signal: AbortSignal.timeout(10_000),

    cache: "no-store",
  });

  if (response.status !== 202) {
    const detail = await response.text().catch(() => "");
    throw new Error("EventSub subscription failed (" + response.status + "): " + detail.slice(0, 300));
  }
  console.log("[fusion-chat] Subscribed to channel.chat.message");
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  const delayMs = Math.min(30_000, 5_000 * (2 ** reconnectAttempts));
  reconnectAttempts = Math.min(reconnectAttempts + 1, 3);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEventSub(EVENTSUB_URL, false);
  }, delayMs);
}

function connectEventSub(url, migrated) {
  if (stopping) return;
  console.log("[fusion-chat] Connecting to Twitch EventSub…");
  const socket = new WebSocketClient(url);
  activeSocket = socket;
  lastMessageAt = Date.now();

  socket.addEventListener("open", () => {
    console.log("[fusion-chat] EventSub WebSocket connected");
    void updateWorkerStatus("connecting");
  });

  socket.addEventListener("message", (messageEvent) => {
    lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(String(messageEvent.data));
    } catch {
      console.error("[fusion-chat] Received invalid EventSub JSON");
      return;
    }

    const messageType = message.metadata?.message_type;
    if (messageType === "session_welcome") {
      keepaliveTimeoutSeconds = message.payload?.session?.keepalive_timeout_seconds || 10;
      if (migrated) {
        reconnectAttempts = 0;
        void updateWorkerStatus("connected");
      } else {
        const sessionId = message.payload?.session?.id;
        if (sessionId) {
          void createSubscription(sessionId)
            .then(() => {
              reconnectAttempts = 0;
              return updateWorkerStatus("connected");
            })
            .catch((error) => {
              console.error("[fusion-chat] Could not subscribe:", error.message);
              if (activeSocket === socket) socket.close();
            });
        }
      }
      return;
    }

    if (messageType === "session_reconnect") {
      const reconnectUrl = message.payload?.session?.reconnect_url;
      if (typeof reconnectUrl === "string") {
        connectEventSub(reconnectUrl, true);
      } else if (activeSocket === socket) {
        socket.close();
      }
      return;
    }

    if (messageType === "notification" &&
        message.metadata?.subscription_type === "channel.chat.message") {
      void handleNotification(message).catch((error) => {
        console.error("[fusion-chat] Chat command failed:", error.message);
      });
      return;
    }

    if (messageType === "revocation") {
      console.error("[fusion-chat] EventSub subscription revoked:", message.payload?.subscription?.status);
      ownerCache = null;
      void updateWorkerStatus("reconnecting");
      if (activeSocket === socket) socket.close();
    }
  });

  socket.addEventListener("close", () => {
    if (activeSocket === socket) {
      activeSocket = null;
      console.warn("[fusion-chat] EventSub disconnected; reconnecting");
      void updateWorkerStatus("reconnecting");
      scheduleReconnect();
    }
  });

  socket.addEventListener("error", () => {
    if (activeSocket === socket) {
      console.error("[fusion-chat] EventSub WebSocket error");
      socket.close();
    }
  });
}

async function acquireWorkerLock() {
  while (!stopping) {
    const candidate = await pool.connect();
    const result = await candidate.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [WORKER_LOCK_ID],
    );

    if (result.rows[0]?.locked) {
      lockClient = candidate;
      lockClient.on("error", (error) => {
        console.error("[fusion-chat] Worker lock connection lost:", error.message);
        if (!stopping) process.exit(1);
      });
      return;
    }

    candidate.release();
    console.log("[fusion-chat] Another instance owns the worker lock; waiting for it to become available");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log("[fusion-chat] Shutting down after", signal);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await updateWorkerStatus("stopped");
  if (activeSocket) activeSocket.close();
  try {
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID]);
      lockClient.release();
      lockClient = null;
    }
  } catch {
    // Closing the connection releases the advisory lock.
  }
  await pool.end();
  process.exit(0);
}

async function waitForOwnerContext() {
  while (!stopping) {
    try {
      await getOwnerContext(true);
      return true;
    } catch (error) {
      console.warn("[fusion-chat] Waiting for broadcaster authorization:", error.message);
      await updateWorkerStatus("waiting_for_auth");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  return false;
}

async function start() {
  await acquireWorkerLock();
  console.log("[fusion-chat] Worker started");
  await updateWorkerStatus("starting");
  if (!(await waitForOwnerContext())) return;
  connectEventSub(EVENTSUB_URL, false);
  heartbeatTimer = setInterval(() => {
    void updateWorkerStatus(currentWorkerStatus);
  }, 15_000);
  keepaliveTimer = setInterval(() => {
    if (
      activeSocket &&
      Date.now() - lastMessageAt > (keepaliveTimeoutSeconds + 5) * 1000
    ) {
      console.warn("[fusion-chat] EventSub keepalive timeout; reconnecting");
      activeSocket.close();
    }
  }, 5_000);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("[fusion-chat] Unhandled rejection:", error);
});

start().catch((error) => {
  console.error("[fusion-chat] Worker could not start:", error.message);
  process.exitCode = 1;
});
