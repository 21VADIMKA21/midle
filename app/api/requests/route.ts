import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../lib/session";
import { getPool } from "../../../lib/db";
import { enqueueNextTrack } from "../../../lib/player-queue";
import { invalidateQueueCache } from "../../../lib/queue-cache";

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
    if (!session?.channelId || !session.userId) {
      return NextResponse.json({ error: "Sign in with Twitch to request a track." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as { trackId?: unknown } | null;
    if (typeof body?.trackId !== "string" || !UUID_PATTERN.test(body.trackId)) {
      return NextResponse.json({ error: "A valid trackId is required." }, { status: 400 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    const settings = await client.query<{ requests_enabled: boolean; max_pending_per_user: number }>(
      "SELECT requests_enabled, max_pending_per_user FROM channel_settings WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );
    if (!settings.rows[0] || !settings.rows[0].requests_enabled) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Music requests are currently disabled." }, { status: 403 });
    }

    const track = await client.query(
      `SELECT id FROM tracks
       WHERE id = $1 AND provider = 'local_library' AND is_available = TRUE`,
      [body.trackId],
    );
    if (!track.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This track is not available in the approved music library." }, { status: 404 });
    }

    const pendingCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM requests
       WHERE channel_id = $1
         AND requester_id = $2
         AND status IN ('pending', 'queued')`,
      [session.channelId, session.userId],
    );
    if (Number(pendingCount.rows[0]?.count || 0) >= settings.rows[0].max_pending_per_user) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "You have reached the maximum number of pending requests." }, { status: 429 });
    }

    const duplicate = await client.query(
      `SELECT 1 FROM requests
       WHERE channel_id = $1 AND track_id = $2 AND status IN ('queued', 'playing')
       LIMIT 1`,
      [session.channelId, body.trackId],
    );
    if (duplicate.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This track is already in the queue." }, { status: 409 });
    }

    await client.query(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );

    const requestResult = await client.query<{ id: string }>(
      `INSERT INTO requests (channel_id, track_id, requester_id, status)
       VALUES ($1, $2, $3, 'queued')
       RETURNING id`,
      [session.channelId, body.trackId, session.userId],
    );

    const dispatchedRequestId = await enqueueNextTrack(client, session.channelId, session.userId);

    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'music.request.created', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ requestId: requestResult.rows[0].id, trackId: body.trackId })],
    );

    await client.query("COMMIT");
    invalidateQueueCache();

    return NextResponse.json({
      success: true,
      requestId: requestResult.rows[0].id,
      status: "queued",
      playerCommandQueued: dispatchedRequestId === requestResult.rows[0].id,
    }, { status: 201 });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Music request could not be created." }, { status: 503 });
  } finally {
    client?.release();
  }
}
