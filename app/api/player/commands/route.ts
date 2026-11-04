import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "../../../../lib/db";
import { getCurrentSession } from "../../../../lib/session";
import { enqueueNextTrack } from "../../../../lib/player-queue";
import { invalidateQueueCache } from "../../../../lib/queue-cache";
import { getPlayerDevice } from "../../../../lib/player-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let client: PoolClient | null = null;

  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    await client.query(
      `UPDATE player_commands pc
       SET status = 'acknowledged',
           acknowledged_at = COALESCE(pc.acknowledged_at, NOW()),
           last_error = 'ack_recovered'
       WHERE pc.device_id = $1
         AND pc.command = 'play'
         AND pc.status = 'delivered'
         AND pc.attempts >= 5
         AND pc.delivered_at < NOW() - INTERVAL '10 seconds'
         AND EXISTS (
           SELECT 1 FROM player_events pe
           WHERE pe.request_id = (pc.payload->>'requestId')::uuid
             AND pe.event_type = 'started'
         )`,
      [device.id],
    );

    const expiredCommands = await client.query<{
      command: string;
      payload: { requestId?: string };
    }>(
      `UPDATE player_commands pc
       SET status = 'failed', last_error = 'ack_timeout'
       WHERE pc.device_id = $1
         AND pc.status = 'delivered'
         AND pc.attempts >= 5
         AND pc.delivered_at < NOW() - INTERVAL '10 seconds'
         AND CASE
           WHEN pc.command = 'play' THEN NOT EXISTS (
             SELECT 1 FROM player_events pe
             WHERE pe.request_id = (pc.payload->>'requestId')::uuid
               AND pe.event_type = 'started'
           )
           ELSE TRUE
         END
       RETURNING pc.command, pc.payload`,
      [device.id],
    );

    let failedPlayCommand = false;
    for (const expired of expiredCommands.rows) {
      if (expired.command === "play" && expired.payload?.requestId) {
        const failedRequest = await client.query(
          `UPDATE requests
           SET status = 'failed', rejection_reason = 'player_ack_timeout', updated_at = NOW()
           WHERE id = $1 AND channel_id = $2 AND status IN ('queued', 'playing')
           RETURNING id`,
          [expired.payload.requestId, device.channelId],
        );
        if (failedRequest.rowCount) {
          await client.query(
            `UPDATE queue_state
             SET current_request_id = NULL, revision = revision + 1, updated_at = NOW()
             WHERE channel_id = $1 AND current_request_id = $2`,
            [device.channelId, expired.payload.requestId],
          );
          failedPlayCommand = true;
        }
      }
    }

    if (failedPlayCommand) {
      await enqueueNextTrack(client, device.channelId);
    }

    const commands = await client.query<{
      id: string;
      command: string;
      payload: Record<string, unknown>;
      attempts: number;
      created_at: Date;
    }>(
      `WITH candidates AS (
         SELECT pc.id
         FROM player_commands pc
         JOIN player_devices pd ON pd.id = pc.device_id
         WHERE pc.device_id = $1
           AND pd.revoked_at IS NULL
           AND pc.attempts < 5
           AND (
             pc.status = 'pending'
             OR (pc.status = 'delivered' AND pc.delivered_at < NOW() - INTERVAL '10 seconds')
           )
         ORDER BY pc.id
         LIMIT 20
         FOR UPDATE OF pc SKIP LOCKED
       )
       UPDATE player_commands pc
       SET status = 'delivered',
           delivered_at = NOW(),
           attempts = attempts + 1
       FROM candidates
       WHERE pc.id = candidates.id
       RETURNING pc.id, pc.command, pc.payload, pc.attempts, pc.created_at`,
      [device.id],
    );

    await client.query("COMMIT");

    if (expiredCommands.rowCount) {
      invalidateQueueCache();
    }

    return NextResponse.json({
      device: { id: device.id, name: device.name },
      commands: commands.rows.map((command) => ({
        id: command.id,
        command: command.command,
        payload: command.payload,
        attempts: command.attempts,
        createdAt: command.created_at,
      })),
      polledAt: new Date().toISOString(),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player command service is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_COMMANDS = new Set(["play", "pause", "resume", "skip", "set_volume", "resync_library"]);

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;

  try {
    const session = await getCurrentSession();
    if (!session?.channelId || session.role !== "owner") {
      return NextResponse.json({ error: "Only the channel owner can control the player." }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as {
      deviceId?: unknown;
      command?: unknown;
      payload?: unknown;
    } | null;

    if (
      typeof body?.deviceId !== "string" || !UUID_PATTERN.test(body.deviceId) ||
      typeof body.command !== "string" || !ALLOWED_COMMANDS.has(body.command)
    ) {
      return NextResponse.json({ error: "A valid deviceId and command are required." }, { status: 400 });
    }

    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {};

    if (body.command === "set_volume" &&
        (typeof payload.volume !== "number" || !Number.isFinite(payload.volume) || payload.volume < 0 || payload.volume > 1)) {
      return NextResponse.json({ error: "Volume must be a number between 0 and 1." }, { status: 400 });
    }

    if (body.command === "play" &&
        (typeof payload.requestId !== "string" || !UUID_PATTERN.test(payload.requestId))) {
      return NextResponse.json({ error: "Play command requires a valid requestId." }, { status: 400 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    const deviceResult = await client.query(
      "SELECT id FROM player_devices WHERE id = $1 AND channel_id = $2 AND revoked_at IS NULL FOR UPDATE",
      [body.deviceId, session.channelId],
    );
    if (!deviceResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Active player device not found." }, { status: 404 });
    }

    if (body.command === "play") {
      const requestResult = await client.query(
        `SELECT r.id
         FROM requests r
         JOIN tracks t ON t.id = r.track_id
         WHERE r.id = $1 AND r.channel_id = $2
           AND r.status = 'queued'
           AND t.provider = 'local_library'`,
        [payload.requestId, session.channelId],
      );
      if (!requestResult.rowCount) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Only queued tracks in the approved local library can be played." }, { status: 409 });
      }
    }

    const commandResult = await client.query<{ id: string }>(
      `INSERT INTO player_commands (device_id, channel_id, created_by, command, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [body.deviceId, session.channelId, session.userId, body.command, JSON.stringify(payload)],
    );

    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'player.command.queued', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ deviceId: body.deviceId, command: body.command, commandId: commandResult.rows[0].id })],
    );

    await client.query("COMMIT");
    return NextResponse.json({ success: true, commandId: commandResult.rows[0].id, status: "pending" }, { status: 202 });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player command could not be queued." }, { status: 503 });
  } finally {
    client?.release();
  }
}
