import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../../lib/db";
import { getPlayerDevice } from "../../../../lib/player-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const result = await query<{
      player_status: string | null;
      session_request_id: string | null;
      queue_request_id: string | null;
      last_heartbeat_at: Date | null;
      track_count: number | null;
      synced_at: Date | null;
    }>(
      `SELECT
         ps.status AS player_status,
         ps.current_request_id AS session_request_id,
         qs.current_request_id AS queue_request_id,
         ps.last_heartbeat_at,
         pls.track_count,
         pls.synced_at
       FROM player_devices pd
       LEFT JOIN player_sessions ps ON ps.device_id = pd.id
       LEFT JOIN queue_state qs ON qs.channel_id = pd.channel_id
       LEFT JOIN player_library_syncs pls ON pls.device_id = pd.id
       WHERE pd.id = $1 AND pd.revoked_at IS NULL
       LIMIT 1`,
      [device.id],
    );

    const state = result.rows[0];
    const fresh = !!state?.last_heartbeat_at && Date.now() - state.last_heartbeat_at.getTime() < 45_000;

    return NextResponse.json({
      device: { id: device.id, name: device.name },
      status: fresh ? state.player_status || "online" : "offline",
      currentRequestId: state?.queue_request_id || state?.session_request_id || null,
      trackCount: state?.track_count || 0,
      librarySyncedAt: state?.synced_at || null,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ error: "Player state is temporarily unavailable." }, { status: 503 });
  }
}
