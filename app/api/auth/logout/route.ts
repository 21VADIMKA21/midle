import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool } from "../../../../lib/db";
import { hashSessionToken } from "../../../../lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const token = cookies().get("fusion_session")?.value;

  if (token) {
    try {
      await getPool().query("DELETE FROM sessions WHERE token_hash = $1", [
        hashSessionToken(token),
      ]);
    } catch {
      // Clear the browser cookie even if the database is temporarily unavailable.
    }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set("fusion_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
