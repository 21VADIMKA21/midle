import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../../../lib/session";
import { getPool } from "../../../../../lib/db";
import { invalidateQueueCache } from "../../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;

  try {
    const session = await getCurrentSession();
    if (!session?.channelId || session.role !== "owner") {
      return NextResponse.json({ error: "Only the channel owner can revoke a player." }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as { deviceId?: unknown } | null;
    if (typeof body?.deviceId !== "string" || !UUID_PATTERN.test(body.deviceId)) {
      return NextResponse.json({ error: "A valid deviceId is required." }, { status: 400 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    await client.query(
      "SELECT channel_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );

    const revoked = await client.query(
      `UPDATE player_devices
       SET revoked_at = NOW()
       WHERE id = $1 AND channel_id = $2 AND revoked_at IS NULL
       RETURNING id, name`,
      [body.deviceId, session.channelId],
    );

    if (!revoked.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Active player device not found." }, { status: 404 });
    }

    const activeSession = await client.query<{ current_request_id: string | null }>(
      "SELECT current_request_id FROM player_sessions WHERE device_id = $1 FOR UPDATE",
      [body.deviceId],
    );
    const currentRequestId = activeSession.rows[0]?.current_request_id || null;

    if (currentRequestId) {
      await client.query(
        `UPDATE requests
         SET status = 'queued', position = 0, updated_at = NOW()
         WHERE id = $1 AND channel_id = $2 AND status = 'playing'`,
        [currentRequestId, session.channelId],
      );
      await client.query(
        `UPDATE queue_state
         SET current_request_id = NULL, revision = revision + 1, updated_at = NOW()
         WHERE channel_id = $1 AND current_request_id = $2`,
        [session.channelId, currentRequestId],
      );
    }

    await client.query(
      "UPDATE player_sessions SET status = 'offline', current_request_id = NULL WHERE device_id = $1",
      [body.deviceId],
    );
    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'player.device.revoked', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ deviceId: body.deviceId, name: revoked.rows[0].name })],
    );

    await client.query("COMMIT");
    invalidateQueueCache();

    // Cancel commands after releasing queue/device locks. The revoked token can no longer poll them.
    try {
      await getPool().query(
        "UPDATE player_commands SET status = 'cancelled' WHERE device_id = $1 AND status IN ('pending', 'delivered')",
        [body.deviceId],
      );
    } catch {
      // Revocation remains effective even if best-effort command cleanup fails.
    }

    return NextResponse.json({ success: true });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player revocation is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
