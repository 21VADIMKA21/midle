import { NextResponse } from "next/server";
import { query } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type QueueRow = {
  request_id: string;
  title: string;
  artist: string;
  artwork_url: string | null;
  requester_name: string | null;
  status: string;
  duration_seconds: number | null;
  created_at: string;
};

function formatDuration(seconds: number | null): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export async function GET() {
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

  if (!broadcasterId) {
    return NextResponse.json(
      { error: "The Fusion broadcaster is not configured.", code: "CHANNEL_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  try {
    const channelResult = await query<{ id: string; display_name: string | null; twitch_login: string | null }>(
      "SELECT id, display_name, twitch_login FROM channels WHERE twitch_broadcaster_id = $1 LIMIT 1",
      [broadcasterId],
    );
    const channel = channelResult.rows[0];

    if (!channel) {
      return NextResponse.json({
        channel: null,
        currentTrack: null,
        queue: [],
        player: { status: "not_connected" },
        revision: 0,
      });
    }

    const [queueResult, stateResult, playerResult, voteResult] = await Promise.all([
      query<QueueRow>(
        `SELECT r.id AS request_id, t.title, t.artist, t.artwork_url,
                u.display_name AS requester_name, r.status, t.duration_seconds, r.created_at
         FROM requests r
         JOIN tracks t ON t.id = r.track_id
         JOIN users u ON u.id = r.requester_id
         WHERE r.channel_id = $1 AND r.status IN ('queued', 'playing')
         ORDER BY CASE WHEN r.status = 'playing' THEN 0 ELSE 1 END,
                  COALESCE(r.position, 2147483647), r.created_at
         LIMIT 100`,
        [channel.id],
      ),
      query<{ revision: string; current_request_id: string | null }>(
        "SELECT revision, current_request_id FROM queue_state WHERE channel_id = $1",
        [channel.id],
      ),
      query<{ status: string; last_heartbeat_at: string | null }>(
        `SELECT status, last_heartbeat_at FROM player_sessions
         WHERE channel_id = $1
         ORDER BY last_heartbeat_at DESC NULLS LAST
         LIMIT 1`,
        [channel.id],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM votes
         WHERE channel_id = $1
           AND request_id = (SELECT current_request_id FROM queue_state WHERE channel_id = $1)
           AND vote = 'skip'`,
        [channel.id],
      ),
    ]);

    const rows = queueResult.rows;
    const current = rows.find((row) => row.status === "playing") || null;
    const upcoming = rows.filter((row) => row.status === "queued");
    const player = playerResult.rows[0];
    const playerFresh = !!player?.last_heartbeat_at &&
      Date.now() - new Date(player.last_heartbeat_at).getTime() < 45_000;

    return NextResponse.json({
      channel: {
        displayName: channel.display_name || channel.twitch_login,
        login: channel.twitch_login,
      },
      currentTrack: current ? {
        id: current.request_id,
        title: current.title,
        artist: current.artist,
        artworkUrl: current.artwork_url,
        requester: current.requester_name,
        duration: formatDuration(current.duration_seconds),
        skipVotes: Number(voteResult.rows[0]?.count || 0),
      } : null,
      queue: upcoming.map((row, index) => ({
        id: row.request_id,
        position: index + 1,
        title: row.title,
        artist: row.artist,
        artworkUrl: row.artwork_url,
        requester: row.requester_name,
        duration: formatDuration(row.duration_seconds),
      })),
      player: {
        status: playerFresh ? player.status : "offline",
        lastSeenAt: player?.last_heartbeat_at || null,
      },
      revision: Number(stateResult.rows[0]?.revision || 0),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json(
      { error: "Queue service is temporarily unavailable.", code: "QUEUE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
