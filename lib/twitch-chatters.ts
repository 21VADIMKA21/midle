import { query } from "./db";
import { decryptToken, encryptToken } from "./security";

type StoredBroadcasterToken = {
  user_id: string;
  twitch_user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  scopes: string[];
  expires_at: Date;
};

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
};

type ChattersResponse = {
  data?: Array<{ user_id: string }>;
  pagination?: { cursor?: string };
  total?: number;
};

type CachedChatters = {
  ids: Set<string>;
  total: number;
  expiresAt: number;
};

const chattersCache = new Map<string, CachedChatters>();

export async function getBroadcasterToken(broadcasterId: string): Promise<{
  accessToken: string;
  broadcasterUserId: string;
  scopes: string[];
}> {
  const storedResult = await query<StoredBroadcasterToken>(
    `SELECT u.id AS user_id, u.twitch_user_id,
            tt.access_token_encrypted, tt.refresh_token_encrypted,
            tt.scopes, tt.expires_at
     FROM channels c
     JOIN channel_roles cr ON cr.channel_id = c.id AND cr.role = 'owner'
     JOIN users u ON u.id = cr.user_id
     JOIN twitch_tokens tt ON tt.user_id = u.id
     WHERE c.twitch_broadcaster_id = $1
     LIMIT 1`,
    [broadcasterId],
  );

  const stored = storedResult.rows[0];
  if (!stored) throw new Error("The broadcaster has not connected Twitch yet");

  let accessToken = decryptToken(stored.access_token_encrypted);
  let refreshToken = decryptToken(stored.refresh_token_encrypted);
  let scopes = stored.scopes || [];

  if (!scopes.includes("moderator:read:chatters")) {
    throw new Error("The broadcaster must reauthorize Twitch with moderator:read:chatters");
  }

  if (stored.expires_at.getTime() < Date.now() + 120_000) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Twitch application credentials are not configured");

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      cache: "no-store",
    });

    if (!response.ok) throw new Error("Could not refresh the broadcaster Twitch token");
    const refreshed = await response.json() as RefreshResponse;
    if (!refreshed.access_token || !refreshed.refresh_token || !refreshed.expires_in) {
      throw new Error("Twitch token refresh response was incomplete");
    }

    accessToken = refreshed.access_token;
    refreshToken = refreshed.refresh_token;
    scopes = refreshed.scope?.length ? refreshed.scope : scopes;

    await query(
      `UPDATE twitch_tokens
       SET access_token_encrypted = $2,
           refresh_token_encrypted = $3,
           scopes = $4,
           expires_at = $5,
           updated_at = NOW()
       WHERE user_id = $1`,
      [
        stored.user_id,
        encryptToken(accessToken),
        encryptToken(refreshToken),
        scopes,
        new Date(Date.now() + refreshed.expires_in * 1000),
      ],
    );
  }

  return {
    accessToken,
    broadcasterUserId: stored.twitch_user_id,
    scopes,
  };
}

export async function getLiveChatters(
  broadcasterId: string,
): Promise<{ userIds: Set<string>; total: number }> {
  const cached = chattersCache.get(broadcasterId);
  if (cached && Date.now() < cached.expiresAt) {
    return { userIds: cached.ids, total: cached.total };
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) throw new Error("TWITCH_CLIENT_ID is not configured");

  const token = await getBroadcasterToken(broadcasterId);
  const userIds = new Set<string>();
  let cursor: string | undefined;
  let total = 0;
  let page = 0;

  do {
    const url = new URL("https://api.twitch.tv/helix/chat/chatters");
    url.searchParams.set("broadcaster_id", broadcasterId);
    url.searchParams.set("moderator_id", token.broadcasterUserId);
    url.searchParams.set("first", "1000");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token.accessToken,
        "Client-Id": clientId,
      },
      cache: "no-store",
    });

    if (!response.ok) throw new Error("Could not retrieve Twitch chatters");
    const data = await response.json() as ChattersResponse;
    if (page === 0) total = data.total || 0;

    for (const chatter of data.data || []) {
      if (chatter.user_id) userIds.add(chatter.user_id);
    }

    cursor = data.pagination?.cursor;
    page += 1;
  } while (cursor && page < 100);

  const result = { ids: userIds, total, expiresAt: Date.now() + 10_000 };
  chattersCache.set(broadcasterId, result);
  return { userIds, total };
}
