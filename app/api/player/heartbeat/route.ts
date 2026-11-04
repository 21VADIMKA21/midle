import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../lib/db";
import { getPlayerDevice } from "../../../../lib/player-auth";
import { invalidateQueueCache } from "../../../../lib/queue-cache";
import { enqueueNextTrack } from "../../../../lib/player-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAYER_STATUSES = new Set(["online", "playing", "paused", "offline", "error"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as {
      status?: unknown;
      currentRequestId?: unknown;
      clientVersion?: unknown;
    } | null;

    if (!body || typeof body.status !== "string" || !PLAYER_STATUSES.has(body.status) ||
        !Object.prototype.hasOwnProperty.call(body, "currentRequestId")) {
      return NextResponse.json({ error: "A valid player status and currentRequestId are required." }, { status: 400 });
    }

    const currentRequestId = body.currentRequestId === null
      ? null
      : typeof body.currentRequestId === "string" && UUID_PATTERN.test(body.currentRequestId)
        ? body.currentRequestId
        : undefined;

    if (currentRequestId === undefined || (body.status === "playing" && !currentRequestId)) {
      return NextResponse.json({ error: "currentRequestId must be a valid request ID or null." }, { status: 400 });
    }

    const clientVersion = typeof body.clientVersion === "string"
      ? body.clientVersion.trim().slice(0, 40)
      : null;

    const pool = getPool();
    const client = await pool.connect();
    let nextRequestId: string | null = null;

    try {
      await client.query("BEGIN");

      if (currentRequestId) {
        const requestResult = await client.query(
          `SELECT 1 FROM requests
           WHERE id = $1 AND channel_id = $2 AND status IN ('queued', 'playing')`,
          [currentRequestId, device.channelId],
        );
        if (!requestResult.rowCount) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "Current request does not belong to this channel or is not playable." }, { status: 409 });
        }
      }

      await client.query(
        `INSERT INTO player_sessions
           (channel_id, device_id, client_version, status, current_request_id, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (device_id) WHERE device_id IS NOT NULL
         DO UPDATE SET
           client_version = EXCLUDED.client_version,
           status = EXCLUDED.status,
           current_request_id = EXCLUDED.current_request_id,
           last_heartbeat_at = NOW()`,
        [device.channelId, device.id, clientVersion, body.status, currentRequestId],
      );

      await client.query(
        "UPDATE player_devices SET last_seen_at = NOW() WHERE id = $1",
        [device.id],
      );

      if (body.status === "online" && currentRequestId === null) {
        nextRequestId = await enqueueNextTrack(client, device.channelId);
      }

      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
      throw error;
    } finally {
      client.release();
    }

    invalidateQueueCache();

    return NextResponse.json({ success: true, receivedAt: new Date().toISOString(), nextRequestId });
  } catch {
    return NextResponse.json({ error: "Player heartbeat is temporarily unavailable." }, { status: 503 });
  }
}
