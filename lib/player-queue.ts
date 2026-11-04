import type { PoolClient } from "pg";

export async function enqueueNextTrack(
  client: PoolClient,
  channelId: string,
  createdBy: string | null = null,
): Promise<string | null> {
  const state = await client.query<{ current_request_id: string | null }>(
    "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
    [channelId],
  );

  if (!state.rows[0] || state.rows[0].current_request_id) {
    return null;
  }

  const recentPlayCommand = await client.query(
    `SELECT 1 FROM player_commands
     WHERE channel_id = $1
       AND command = 'play'
       AND status IN ('pending', 'delivered', 'acknowledged')
       AND created_at > NOW() - INTERVAL '30 seconds'
     LIMIT 1`,
    [channelId],
  );
  if (recentPlayCommand.rowCount) return null;

  const player = await client.query<{ id: string }>(
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

  const next = await client.query<{ id: string }>(
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
