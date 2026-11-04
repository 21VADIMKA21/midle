import { getBroadcasterToken } from "./twitch-chatters";

type ModeratorsResponse = {
  data?: Array<{ user_id: string; user_login: string; user_name: string }>;
  pagination?: { cursor?: string };
};

export type TwitchModerator = {
  userId: string;
  login: string;
  displayName: string;
};

export async function getTwitchModerators(broadcasterId: string): Promise<TwitchModerator[]> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) throw new Error("TWITCH_CLIENT_ID is not configured");

  const token = await getBroadcasterToken(broadcasterId);
  if (!token.scopes.includes("moderation:read")) {
    throw new Error("The broadcaster must reauthorize Twitch with moderation:read");
  }

  const moderators: TwitchModerator[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const url = new URL("https://api.twitch.tv/helix/moderation/moderators");
    url.searchParams.set("broadcaster_id", broadcasterId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + token.accessToken,
        "Client-Id": clientId,
      },
      cache: "no-store",
    });

    if (!response.ok) throw new Error("Could not retrieve Twitch moderators");
    const data = await response.json() as ModeratorsResponse;

    for (const moderator of data.data || []) {
      moderators.push({
        userId: moderator.user_id,
        login: moderator.user_login,
        displayName: moderator.user_name,
      });
    }

    cursor = data.pagination?.cursor;
    pages += 1;
  } while (cursor && pages < 100);

  return moderators;
}
