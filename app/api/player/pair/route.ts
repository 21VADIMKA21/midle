import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../../lib/session";
import { getPool } from "../../../../lib/db";
import { hashSessionToken } from "../../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasValidOrigin(request: NextRequest): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }

  if (origin.protocol !== "https:" && origin.protocol !== "http:") return false;
  if (origin.username || origin.password) return false;

  // Railway terminates TLS before forwarding requests to Next.js. The
  // internal request URL can therefore differ from the browser's public URL.
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const allowedHosts = new Set([requestHost.toLowerCase()]);

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      allowedHosts.add(new URL(appUrl).host.toLowerCase());
    } catch {
      // The request host remains the fallback if APP_URL is malformed.
    }
  }

  if (!allowedHosts.has(origin.host.toLowerCase())) return false;

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto && origin.protocol !== `${forwardedProto}:`) return false;

  return true;
}

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;

  try {
    const session = await getCurrentSession();
    if (!session?.channelId || session.role !== "owner") {
      return NextResponse.json({ error: "Only the channel owner can pair a player." }, { status: 403 });
    }

    const body = await request.json().catch(() => null) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) {
      return NextResponse.json({ error: "Device name must contain 1–100 characters." }, { status: 400 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [session.channelId]);

    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM player_devices WHERE channel_id = $1 AND revoked_at IS NULL",
      [session.channelId],
    );

    if (Number(countResult.rows[0]?.count || 0) >= 1) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This channel already has the only one active player is supported for this channel." }, { status: 409 });
    }

    const deviceToken = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(deviceToken);

    const deviceResult = await client.query<{ id: string; name: string }>(
      `INSERT INTO player_devices (channel_id, name, token_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name`,
      [session.channelId, name, tokenHash],
    );

    const device = deviceResult.rows[0];
    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'player.device.paired', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ deviceId: device.id, name })],
    );

    await client.query("COMMIT");

    return NextResponse.json({
      success: true,
      device: { id: device.id, name: device.name },
      deviceToken,
      warning: "Copy this token now. It will not be shown again.",
    });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player pairing is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
