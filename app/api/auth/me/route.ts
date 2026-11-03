import { NextResponse } from "next/server";
import { getCurrentSession } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: session.userId,
        twitchId: session.twitchUserId,
        login: session.login,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
        role: session.role,
      },
    });
  } catch {
    return NextResponse.json(
      { authenticated: false, error: "Session service unavailable" },
      { status: 503 },
    );
  }
}
