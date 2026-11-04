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

  await client.query(
    `INSERT INTO player_sessions
       (channel_id, device_id, client_version, status, current_request_id, last_heartbeat_at)
     VALUES ($1, $2, 'ci-smoke', 'playing', $3, NOW())`,
    [channelId, playerId, requestId],
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

  const votes = await client.query(
    "SELECT COUNT(*)::int AS count FROM votes WHERE channel_id = $1 AND request_id = $2",
    [channelId, requestId],
  );
  if (votes.rows[0].count !== 1) {
    throw new Error("Duplicate skip votes were not constrained correctly");
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
  console.log("Database smoke checks passed: queue integrity, unique skip votes, local library sync metadata, player command acknowledgements and idempotent player events.");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* connection already failed */ }
  console.error("Database smoke checks failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
