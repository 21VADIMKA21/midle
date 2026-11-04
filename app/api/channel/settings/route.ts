import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "../../../../lib/session";
import { query, getPool } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
  if (!broadcasterId) {
    return NextResponse.json({ requestsEnabled: false, configured: false });
  }

  try {
    const result = await query<{
      requests_enabled: boolean;
      max_pending_per_user: number;
      skip_vote_percent: number;
    }>(
      `SELECT cs.requests_enabled, cs.max_pending_per_user, cs.skip_vote_percent
       FROM channel_settings cs
       JOIN channels c ON c.id = cs.channel_id
       WHERE c.twitch_broadcaster_id = $1
       LIMIT 1`,
      [broadcasterId],
    );

    const settings = result.rows[0];
    return NextResponse.json({
      configured: !!settings,
      requestsEnabled: settings?.requests_enabled || false,
      maxPendingPerUser: settings?.max_pending_per_user || 1,
      skipVotePercent: settings?.skip_vote_percent || 50,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ error: "Channel settings are temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const session = await getCurrentSession();
  if (!session?.channelId || session.role !== "owner") {
    return NextResponse.json({ error: "Only the channel owner can change settings." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as {
    requestsEnabled?: unknown;
    maxPendingPerUser?: unknown;
    skipVotePercent?: unknown;
  } | null;

  if (
    !body ||
    (body.requestsEnabled !== undefined && typeof body.requestsEnabled !== "boolean") ||
    (body.maxPendingPerUser !== undefined &&
      (typeof body.maxPendingPerUser !== "number" || !Number.isInteger(body.maxPendingPerUser) || body.maxPendingPerUser < 1 || body.maxPendingPerUser > 5)) ||
    (body.skipVotePercent !== undefined &&
      (typeof body.skipVotePercent !== "number" || !Number.isInteger(body.skipVotePercent) || body.skipVotePercent < 10 || body.skipVotePercent > 100))
  ) {
    return NextResponse.json({ error: "Invalid channel settings." }, { status: 400 });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (body.requestsEnabled === true) {
      const library = await client.query(
        "SELECT 1 FROM tracks WHERE provider = 'local_library' AND is_available = TRUE LIMIT 1",
      );
      const player = await client.query(
        `SELECT 1
         FROM player_devices pd
         JOIN player_library_syncs pls ON pls.device_id = pd.id
         WHERE pd.channel_id = $1
           AND pd.revoked_at IS NULL
           AND pls.track_count > 0
           AND pls.synced_at > NOW() - INTERVAL '30 days'
         LIMIT 1`,
        [session.channelId],
      );
      if (!library.rowCount || !player.rowCount) {
        await client.query("ROLLBACK");
        return NextResponse.json({
          error: "Sync an approved local music library and pair Fusion Player before enabling requests.",
        }, { status: 409 });
      }
    }

    const result = await client.query<{
      requests_enabled: boolean;
      max_pending_per_user: number;
      skip_vote_percent: number;
    }>(
      `UPDATE channel_settings
       SET requests_enabled = COALESCE($2, requests_enabled),
           max_pending_per_user = COALESCE($3, max_pending_per_user),
           skip_vote_percent = COALESCE($4, skip_vote_percent),
           updated_at = NOW()
       WHERE channel_id = $1
       RETURNING requests_enabled, max_pending_per_user, skip_vote_percent`,
      [
        session.channelId,
        body.requestsEnabled ?? null,
        body.maxPendingPerUser ?? null,
        body.skipVotePercent ?? null,
      ],
    );

    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Channel settings have not been initialized." }, { status: 409 });
    }

    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'channel.settings.updated', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify(body)],
    );

    await client.query("COMMIT");
    return NextResponse.json({
      success: true,
      requestsEnabled: result.rows[0].requests_enabled,
      maxPendingPerUser: result.rows[0].max_pending_per_user,
      skipVotePercent: result.rows[0].skip_vote_percent,
    });
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    return NextResponse.json({ error: "Channel settings could not be updated." }, { status: 503 });
  } finally {
    client.release();
  }
}
