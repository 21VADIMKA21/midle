import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getCurrentSession } from "../../../../../lib/session";
import { getPool } from "../../../../../lib/db";
import { getTwitchModerators } from "../../../../../lib/twitch-moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let client: PoolClient | null = null;

  try {
    const session = await getCurrentSession();
    if (!session?.channelId || session.role !== "owner" || !session.broadcasterId) {
      return NextResponse.json({ error: "Only the channel owner can sync moderators." }, { status: 403 });
    }

    let moderators;
    try {
      moderators = await getTwitchModerators(session.broadcasterId);
    } catch {
      return NextResponse.json({
        error: "Could not sync moderators. Reconnect the broadcaster Twitch account and approve moderation:read.",
      }, { status: 503 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    const moderatorIds = moderators
      .filter((moderator) => moderator.userId !== session.broadcasterId)
      .map((moderator) => moderator.userId);

    for (const moderator of moderators) {
      if (moderator.userId === session.broadcasterId) continue;

      const user = await client.query<{ id: string }>(
        `INSERT INTO users (twitch_user_id, twitch_login, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (twitch_user_id) DO UPDATE SET
           twitch_login = EXCLUDED.twitch_login,
           display_name = EXCLUDED.display_name,
           updated_at = NOW()
         RETURNING id`,
        [moderator.userId, moderator.login, moderator.displayName],
      );

      await client.query(
        `INSERT INTO channel_roles (channel_id, user_id, role)
         VALUES ($1, $2, 'moderator')
         ON CONFLICT (channel_id, user_id) DO UPDATE SET
           role = CASE WHEN channel_roles.role = 'owner' THEN 'owner' ELSE 'moderator' END`,
        [session.channelId, user.rows[0].id],
      );
    }

    await client.query(
      `DELETE FROM channel_roles cr
       USING users u
       WHERE cr.channel_id = $1
         AND cr.user_id = u.id
         AND cr.role = 'moderator'
         AND NOT (u.twitch_user_id = ANY($2::text[]))`,
      [session.channelId, moderatorIds],
    );

    await client.query(
      `INSERT INTO audit_log (channel_id, actor_user_id, action, details)
       VALUES ($1, $2, 'channel.moderators.synced', $3::jsonb)`,
      [session.channelId, session.userId, JSON.stringify({ moderatorCount: moderatorIds.length })],
    );

    await client.query("COMMIT");
    return NextResponse.json({ success: true, moderatorCount: moderatorIds.length });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Moderator synchronization is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
