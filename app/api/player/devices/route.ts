import { NextResponse } from "next/server";
import { getCurrentSession } from "../../../../lib/session";
import { query } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getCurrentSession();
    if (!session?.channelId || session.role !== "owner") {
      return NextResponse.json({ error: "Only the channel owner can view paired players." }, { status: 403 });
    }

    const result = await query<{
      id: string;
      name: string;
      created_at: Date;
      last_seen_at: Date | null;
      status: string | null;
      current_request_id: string | null;
    }>(
      `SELECT pd.id, pd.name, pd.created_at, pd.last_seen_at,
              ps.status, ps.current_request_id
       FROM player_devices pd
       LEFT JOIN player_sessions ps ON ps.device_id = pd.id
       WHERE pd.channel_id = $1 AND pd.revoked_at IS NULL
       ORDER BY pd.created_at DESC`,
      [session.channelId],
    );

    return NextResponse.json({
      devices: result.rows.map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        status: device.last_seen_at && Date.now() - device.last_seen_at.getTime() < 45_000
          ? device.status || "online"
          : "offline",
        currentRequestId: device.current_request_id,
      })),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ error: "Player devices are temporarily unavailable." }, { status: 503 });
  }
}
