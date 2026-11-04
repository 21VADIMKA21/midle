import "dotenv/config";
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
  console.log("Database smoke checks passed: queue integrity and unique skip votes.");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* connection already failed */ }
  console.error("Database smoke checks failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
