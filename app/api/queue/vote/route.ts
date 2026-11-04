import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../../lib/session";
import { getPool } from "../../../../lib/db";
import { getLiveViewerCount } from "../../../../lib/twitch-viewers";
import { getLiveChatters } from "../../../../lib/twitch-chatters";
import { invalidateQueueCache } from "../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;
  let transactionOpen = false;

  try {
    const session = await getCurrentSession();
    if (!session?.userId || !session.channelId) {
      return NextResponse.json({ error: "Sign in with Twitch to vote." }, { status: 401 });
    }

    const broadcasterId = session.broadcasterId;
    if (!broadcasterId) {
      return NextResponse.json({ error: "The Twitch channel is not configured." }, { status: 503 });
    }

    let viewerCount: number | null;
    try {
      viewerCount = await getLiveViewerCount(broadcasterId);
    } catch {
      return NextResponse.json({ error: "Could not verify the live audience. Try again shortly." }, { status: 503 });
    }
    if (viewerCount === null) {
      return NextResponse.json({ error: "Skip voting is available while the Twitch channel is live." }, { status: 409 });
    }

    let chatters: { userIds: Set<string>; total: number };
    try {
      chatters = await getLiveChatters(broadcasterId);
    } catch {
      return NextResponse.json({
        error: "Twitch chat eligibility could not be verified. The channel owner may need to reconnect Twitch with chatters permission.",
      }, { status: 503 });
    }

    if (!chatters.userIds.has(session.twitchUserId)) {
      return NextResponse.json({ error: "Only users currently present in the channel chat can vote." }, { status: 403 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");
    transactionOpen = true;

    const stateResult = await client.query<{ current_request_id: string | null }>(
      "SELECT current_request_id FROM queue_state WHERE channel_id = $1 FOR UPDATE",
      [session.channelId],
    );
    const currentRequestId = stateResult.rows[0]?.current_request_id;

    if (!currentRequestId) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return NextResponse.json({ error: "There is no active track to vote on." }, { status: 409 });
    }

    const currentResult = await client.query(
      "SELECT 1 FROM requests WHERE id = $1 AND channel_id = $2 AND status = 'playing'",
      [currentRequestId, session.channelId],
    );

    if (!currentResult.rowCount) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return NextResponse.json({ error: "The active track has changed. Refresh the queue." }, { status: 409 });
    }

    const settings = await client.query<{ skip_vote_percent: number }>(
      "SELECT skip_vote_percent FROM channel_settings WHERE channel_id = $1",
      [session.channelId],
    );
    const skipVotePercent = settings.rows[0]?.skip_vote_percent || 50;

    const voteResult = await client.query(
      `INSERT INTO votes (channel_id, request_id, user_id, vote)
       VALUES ($1, $2, $3, 'skip')
       ON CONFLICT (channel_id, request_id, user_id) DO NOTHING`,
      [session.channelId, currentRequestId, session.userId],
    );

    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM votes WHERE channel_id = $1 AND request_id = $2 AND vote = 'skip'",
      [session.channelId, currentRequestId],
    );
    const skipVotes = Number(countResult.rows[0]?.count || 0);
    const skipThreshold = Math.max(1, Math.ceil(chatters.total * skipVotePercent / 100));
    let skipCommandQueued = false;

    if (skipVotes >= skipThreshold) {
      const device = await client.query<{ id: string }>(
        "SELECT id FROM player_devices WHERE channel_id = $1 AND revoked_at IS NULL LIMIT 1 FOR UPDATE",
        [session.channelId],
      );

      if (device.rows[0]) {
        const existingCommand = await client.query(
          `SELECT 1 FROM player_commands
           WHERE device_id = $1
             AND command = 'skip'
             AND payload->>'requestId' = $2
             AND status IN ('pending', 'delivered', 'acknowledged')
           LIMIT 1`,
          [device.rows[0].id, currentRequestId],
        );

        if (!existingCommand.rowCount) {
          await client.query(
            `INSERT INTO player_commands (device_id, channel_id, created_by, command, payload)
             VALUES ($1, $2, $3, 'skip', $4::jsonb)`,
            [device.rows[0].id, session.channelId, session.userId, JSON.stringify({ requestId: currentRequestId })],
          );
        }
        skipCommandQueued = true;
      }
    }

    await client.query("COMMIT");
    transactionOpen = false;
    if (broadcasterId) invalidateQueueCache(broadcasterId);

    return NextResponse.json({
      success: true,
      requestId: currentRequestId,
      skipVotes,
      skipThreshold,
      viewerCount,
      eligibleChatters: chatters.total,
      skipVotePercent,
      thresholdReached: skipVotes >= skipThreshold,
      skipCommandQueued,
      alreadyVoted: voteResult.rowCount === 0,
    });
  } catch {
    if (client && transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Voting is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
