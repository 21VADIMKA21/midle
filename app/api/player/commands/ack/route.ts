import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "../../../../../lib/db";
import { getPlayerDevice } from "../../../../../lib/player-auth";
import { enqueueNextTrack } from "../../../../../lib/player-queue";
import { invalidateQueueCache } from "../../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let client: PoolClient | null = null;

  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as {
      commandId?: unknown;
      success?: unknown;
      errorCode?: unknown;
    } | null;

    const commandId = typeof body?.commandId === "string" ? body.commandId : "";
    const success = body?.success === true;
    const errorCode = typeof body?.errorCode === "string"
      ? body.errorCode.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
      : null;

    if (!/^\d{1,19}$/.test(commandId) || typeof body?.success !== "boolean") {
      return NextResponse.json({ error: "commandId and success are required." }, { status: 400 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    const command = await client.query<{
      command: string;
      payload: { requestId?: string };
    }>(
      `SELECT command, payload
       FROM player_commands
       WHERE id = $1 AND device_id = $2 AND status = 'delivered'
       FOR UPDATE`,
      [commandId, device.id],
    );

    if (!command.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Command not found or no longer awaiting acknowledgement." }, { status: 404 });
    }

    await client.query(
      `UPDATE player_commands
       SET status = $3,
           acknowledged_at = NOW(),
           last_error = $4
       WHERE id = $1 AND device_id = $2`,
      [commandId, device.id, success ? "acknowledged" : "failed", success ? null : errorCode || "player_error"],
    );

    let nextRequestId: string | null = null;
    if (!success && command.rows[0].command === "play" && command.rows[0].payload?.requestId) {
      await client.query(
        `UPDATE requests
         SET status = 'failed', rejection_reason = $3, updated_at = NOW()
         WHERE id = $1 AND channel_id = $2 AND status IN ('queued', 'playing')`,
        [command.rows[0].payload.requestId, device.channelId, errorCode || "player_error"],
      );
      await client.query(
        `UPDATE queue_state
         SET current_request_id = NULL, revision = revision + 1, updated_at = NOW()
         WHERE channel_id = $1 AND current_request_id = $2`,
        [device.channelId, command.rows[0].payload.requestId],
      );
      nextRequestId = await enqueueNextTrack(client, device.channelId);
    }

    await client.query("COMMIT");
    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    if (broadcasterId) invalidateQueueCache(broadcasterId);

    return NextResponse.json({
      success: true,
      commandId,
      status: success ? "acknowledged" : "failed",
      nextRequestId,
    });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Command acknowledgement is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
