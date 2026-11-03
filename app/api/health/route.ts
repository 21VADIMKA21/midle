import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        status: "degraded",
        service: "fusion-music",
        database: "not_configured",
        checkedAt,
      },
      { status: 503 },
    );
  }

  try {
    await query("SELECT 1");
    return NextResponse.json({
      status: "ok",
      service: "fusion-music",
      database: "connected",
      checkedAt,
    });
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        service: "fusion-music",
        database: "unavailable",
        checkedAt,
      },
      { status: 503 },
    );
  }
}
