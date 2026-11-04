type AppTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type StreamsResponse = {
  data?: Array<{ viewer_count?: number }>;
};

let appAccessToken: string | null = null;
let appTokenExpiresAt = 0;
let cachedViewerCount: number | null | undefined;
let viewerCountExpiresAt = 0;

async function getAppAccessToken(): Promise<string> {
  if (appAccessToken && Date.now() < appTokenExpiresAt - 60_000) {
    return appAccessToken;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Twitch application credentials are not configured");
  }

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(10_000),

    cache: "no-store",
  });

  if (!response.ok) throw new Error("Could not obtain Twitch app access token");
  const data = await response.json() as AppTokenResponse;
  if (!data.access_token || !data.expires_in) {
    throw new Error("Twitch app access token response was incomplete");
  }

  appAccessToken = data.access_token;
  appTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return appAccessToken;
}

export async function getLiveViewerCount(broadcasterId: string): Promise<number | null> {
  if (cachedViewerCount !== undefined && Date.now() < viewerCountExpiresAt) {
    return cachedViewerCount;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) throw new Error("TWITCH_CLIENT_ID is not configured");

  const token = await getAppAccessToken();
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_id", broadcasterId);

  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      "Client-Id": clientId,
    },
    signal: AbortSignal.timeout(10_000),

    cache: "no-store",
  });

  if (!response.ok) throw new Error("Could not retrieve Twitch live viewer count");
  const data = await response.json() as StreamsResponse;
  const count = data.data?.[0]?.viewer_count;

  cachedViewerCount = typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : null;
  viewerCountExpiresAt = Date.now() + 15_000;
  return cachedViewerCount;
}
