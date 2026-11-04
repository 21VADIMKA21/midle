import { NextResponse } from "next/server";
import { query } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date();

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        status: "degraded",
        service: "fusion-music",
        database: "not_configured",
        checkedAt: checkedAt.toISOString(),
      },
      { status: 503 },
    );
  }

  try {
    await query("SELECT 1");

    let chatWorker = {
      status: "not_started",
      lastHeartbeatAt: null as string | null,
      degraded: true,
    };

    try {
      const heartbeat = await query<{
        status: string;
        last_heartbeat_at: Date;
      }>(
        "SELECT status, last_heartbeat_at FROM service_heartbeats WHERE service_name = 'twitch-chat' LIMIT 1",
      );
      const row = heartbeat.rows[0];
      if (row) {
        const lastHeartbeatAt = new Date(row.last_heartbeat_at);
        const stale = checkedAt.getTime() - lastHeartbeatAt.getTime() > 45_000;
        chatWorker = {
          status: stale ? "stale" : row.status,
          lastHeartbeatAt: lastHeartbeatAt.toISOString(),
          degraded: stale || row.status !== "connected",
        };
      }
    } catch {
      // The web service can still be healthy before the chat worker migration is applied.
    }

    return NextResponse.json({
      status: "ok",
      service: "fusion-music",
      database: "connected",
      chatWorker,
      checkedAt: checkedAt.toISOString(),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        service: "fusion-music",
        database: "unavailable",
        checkedAt: checkedAt.toISOString(),
      },
      { status: 503 },
    );
  }
}
