import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../../lib/db";
import { getPlayerDevice } from "../../../../../lib/player-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as {
      commandId?: unknown;
      success?: unknown;
      errorCode?: unknown;
    } | null;

    const commandId = typeof body?.commandId === "string" || typeof body?.commandId === "number"
      ? String(body.commandId)
      : "";
    const success = body?.success === true;
    const errorCode = typeof body?.errorCode === "string"
      ? body.errorCode.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
      : null;

    if (!/^\d{1,18}$/.test(commandId) || typeof body?.success !== "boolean") {
      return NextResponse.json({ error: "commandId and success are required." }, { status: 400 });
    }

    const result = await getPool().query(
      `UPDATE player_commands
       SET status = $3,
           acknowledged_at = NOW(),
           last_error = $4
       WHERE id = $1
         AND device_id = $2
         AND status = 'delivered'`,
      [commandId, device.id, success ? "acknowledged" : "failed", success ? null : errorCode || "player_error"],
    );

    if (!result.rowCount) {
      return NextResponse.json({ error: "Command not found or no longer awaiting acknowledgement." }, { status: 404 });
    }

    return NextResponse.json({ success: true, commandId, status: success ? "acknowledged" : "failed" });
  } catch {
    return NextResponse.json({ error: "Command acknowledgement is temporarily unavailable." }, { status: 503 });
  }
}
