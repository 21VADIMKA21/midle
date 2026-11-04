import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../../lib/db";
import { getPlayerDevice } from "../../../../../lib/player-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const { id } = await context.params;
    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: "Invalid request ID." }, { status: 400 });
    }

    const result = await query<{
      request_id: string;
      provider_track_id: string;
      title: string;
      artist: string;
      duration_seconds: number | null;
    }>(
      `SELECT r.id AS request_id, t.provider_track_id, t.title, t.artist, t.duration_seconds
       FROM requests r
       JOIN tracks t ON t.id = r.track_id
       WHERE r.id = $1
         AND r.channel_id = $2
         AND r.status IN ('queued', 'playing')
         AND t.provider = 'local_library'
         AND t.is_available = TRUE
       LIMIT 1`,
      [id, device.channelId],
    );

    const track = result.rows[0];
    if (!track) {
      return NextResponse.json({ error: "Track is no longer available." }, { status: 404 });
    }

    return NextResponse.json({
      requestId: track.request_id,
      track: {
        providerTrackId: track.provider_track_id,
        title: track.title,
        artist: track.artist,
        durationSeconds: track.duration_seconds,
      },
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ error: "Player request lookup is temporarily unavailable." }, { status: 503 });
  }
}
