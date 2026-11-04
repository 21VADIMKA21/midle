import { cookies } from "next/headers";
import { getPool } from "./db";
import { hashSessionToken } from "./security";

export type CurrentSession = {
  userId: string;
  twitchUserId: string;
  login: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  channelId: string | null;
  broadcasterId: string | null;
  role: "owner" | "moderator" | "vip" | null;
};

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("fusion_session")?.value;
  if (!token) return null;

  const result = await getPool().query<{
    user_id: string;
    twitch_user_id: string;
    twitch_login: string | null;
    display_name: string | null;
    avatar_url: string | null;
    channel_id: string | null;
    role: "owner" | "moderator" | "vip" | null;
    broadcaster_id: string | null;
  }>(
    `SELECT
       u.id AS user_id,
       u.twitch_user_id,
       u.twitch_login,
       u.display_name,
       u.avatar_url,
       s.channel_id,
       c.twitch_broadcaster_id AS broadcaster_id,
       cr.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN channels c ON c.id = s.channel_id
     LEFT JOIN channel_roles cr
       ON cr.channel_id = s.channel_id AND cr.user_id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
     LIMIT 1`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    twitchUserId: row.twitch_user_id,
    login: row.twitch_login,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    channelId: row.channel_id,
    broadcasterId: row.broadcaster_id,
    role: row.role,
  };
}
