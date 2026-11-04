import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "../../../../../lib/db";
import { getPlayerDevice } from "../../../../../lib/player-auth";
import { invalidateQueueCache } from "../../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  let client: PoolClient | null = null;
  let transactionOpen = false;

  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as {
      eventId?: unknown;
      requestId?: unknown;
      eventType?: unknown;
    } | null;

    if (
      typeof body?.eventId !== "string" || !UUID_PATTERN.test(body.eventId) ||
      typeof body.requestId !== "string" || !UUID_PATTERN.test(body.requestId) ||
      !["started", "finished", "failed"].includes(String(body.eventType))
    ) {
      return NextResponse.json({ error: "eventId, requestId and a valid eventType are required." }, { status: 400 });
    }

    const eventType = body.eventType as "started" | "finished" | "failed";
    client = await getPool().connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const eventInsert = await client.query(
      `INSERT INTO player_events (event_id, device_id, channel_id, request_id, event_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [body.eventId, device.id, device.channelId, body.requestId, eventType],
    );

    if (!eventInsert.rowCount) {
      const existingEvent = await client.query<{
        device_id: string;
        channel_id: string;
        request_id: string;
        event_type: string;
      }>(
        "SELECT device_id, channel_id, request_id, event_type FROM player_events WHERE event_id = $1",
        [body.eventId],
      );
      const existing = existingEvent.rows[0];
      if (
        !existing ||
        existing.device_id !== device.id ||
        existing.channel_id !== device.channelId ||
        existing.request_id !== body.requestId ||
        existing.event_type !== eventType
      ) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return NextResponse.json({ error: "Event ID has already been used for a different player event." }, { status: 409 });
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return NextResponse.json({ success: true, duplicate: true });
    }

    const stateResult = await client.query<{ current_request_id: string | null }>(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [device.channelId],
    );
    if (!stateResult.rows[0]) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return NextResponse.json({ error: "Queue state is not initialized." }, { status: 409 });
    }

    const currentRequestId = stateResult.rows[0].current_request_id;

    if (eventType === "started") {
      const requestResult = await client.query<{ status: string }>(
        "SELECT status FROM requests WHERE id = $1 AND channel_id = $2 FOR UPDATE",
        [body.requestId, device.channelId],
      );
      const requestStatus = requestResult.rows[0]?.status;

      if (requestStatus !== "queued" && requestStatus !== "playing") {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return NextResponse.json({ error: "This request is not available to play." }, { status: 409 });
      }

      if (currentRequestId && currentRequestId !== body.requestId) {
        await client.query(
          "UPDATE requests SET status = 'played', updated_at = NOW() WHERE id = $1 AND channel_id = $2 AND status = 'playing'",
          [currentRequestId, device.channelId],
        );
      }

      await client.query(
        "UPDATE requests SET status = 'playing', position = NULL, updated_at = NOW() WHERE id = $1 AND channel_id = $2",
        [body.requestId, device.channelId],
      );

      if (currentRequestId !== body.requestId) {
        await client.query(
          `UPDATE queue_state
           SET current_request_id = $2, revision = revision + 1, updated_at = NOW()
           WHERE channel_id = $1`,
          [device.channelId, body.requestId],
        );
      }
    } else if (eventType === "finished") {
      if (currentRequestId !== body.requestId) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return NextResponse.json({ error: "This track is no longer the active request." }, { status: 409 });
      }

      await client.query(
        "UPDATE requests SET status = 'played', updated_at = NOW() WHERE id = $1 AND channel_id = $2",
        [body.requestId, device.channelId],
      );
      await client.query(
        `UPDATE queue_state
         SET current_request_id = NULL, revision = revision + 1, updated_at = NOW()
         WHERE channel_id = $1`,
        [device.channelId],
      );
    } else {
      const failedResult = await client.query(
        "UPDATE requests SET status = 'failed', updated_at = NOW() WHERE id = $1 AND channel_id = $2 AND status IN ('queued', 'playing') RETURNING id",
        [body.requestId, device.channelId],
      );
      if (!failedResult.rowCount) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return NextResponse.json({ error: "This request does not belong to this channel or cannot be failed." }, { status: 409 });
      }
      if (currentRequestId === body.requestId) {
        await client.query(
          `UPDATE queue_state
           SET current_request_id = NULL, revision = revision + 1, updated_at = NOW()
           WHERE channel_id = $1`,
          [device.channelId],
        );
      }
    }

    await client.query("COMMIT");
    transactionOpen = false;

    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    if (broadcasterId) invalidateQueueCache(broadcasterId);

    return NextResponse.json({ success: true, duplicate: false });
  } catch {
    if (client && transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player event could not be processed." }, { status: 503 });
  } finally {
    client?.release();
  }
}
