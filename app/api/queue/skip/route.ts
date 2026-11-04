import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../../lib/session";
import { getPool } from "../../../../lib/db";
import { invalidateQueueCache } from "../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;

  try {
    const session = await getCurrentSession();
    if (!session?.channelId || !session.userId || !["owner", "moderator"].includes(session.role || "")) {
      return NextResponse.json({ error: "Only the channel owner or a Twitch moderator can force-skip." }, { status: 403 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    const state = await client.query<{ current_request_id: string | null }>(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );
    const requestId = state.rows[0]?.current_request_id;
    if (!requestId) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "There is no active track to skip." }, { status: 409 });
    }

    const device = await client.query<{ id: string }>(
      "SELECT id FROM player_devices WHERE channel_id = $1 AND revoked_at IS NULL LIMIT 1 FOR UPDATE",
      [session.channelId],
    );
    if (!device.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "The local player is not paired." }, { status: 409 });
    }

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
        [device.rows[0].id, session.channelId, session.userId, JSON.stringify({ requestId })],
      );
    }

    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'music.skip.forced', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ requestId })],
    );

    await client.query("COMMIT");
    invalidateQueueCache();

    return NextResponse.json({ success: true, requestId, commandQueued: true, alreadyQueued: !!existing.rowCount });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Force-skip is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
