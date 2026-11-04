import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "../../../../lib/session";
import { getPool } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const session = await getCurrentSession();
  if (!session?.userId || !session.channelId) {
    return NextResponse.json({ error: "Sign in with Twitch to vote." }, { status: 401 });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const stateResult = await client.query<{ current_request_id: string | null }>(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );
    const currentRequestId = stateResult.rows[0]?.current_request_id;

    if (!currentRequestId) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "There is no active track to vote on." }, { status: 409 });
    }

    const currentResult = await client.query(
      "SELECT 1 FROM requests WHERE id = $1 AND channel_id = $2 AND status = 'playing'",
      [currentRequestId, session.channelId],
    );

    if (!currentResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "The active track has changed. Refresh the queue." }, { status: 409 });
    }

    await client.query(
      `INSERT INTO votes (channel_id, request_id, user_id, vote)
       VALUES ($1, $2, $3, 'skip')
       ON CONFLICT (channel_id, request_id, user_id)
       DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()`,
      [session.channelId, currentRequestId, session.userId],
    );

    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM votes WHERE channel_id = $1 AND request_id = $2 AND vote = 'skip'",
      [session.channelId, currentRequestId],
    );

    await client.query("COMMIT");

    return NextResponse.json({
      success: true,
      requestId: currentRequestId,
      skipVotes: Number(countResult.rows[0]?.count || 0),
    });
  } catch {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "Voting is temporarily unavailable." }, { status: 503 });
  } finally {
    client.release();
  }
}
