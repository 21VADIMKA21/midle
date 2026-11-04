import { NextRequest, NextResponse } from "next/server";
import { encryptToken, createSessionToken, hashSessionToken } from "../../../../lib/security";
import { getPool } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TwitchTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
};

type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
};

function redirectWithStatus(request: NextRequest, status: string) {
  const target = new URL("/", process.env.APP_URL || request.nextUrl.origin);
  target.searchParams.set("auth", status);
  const response = NextResponse.redirect(target);
  response.cookies.set("fusion_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const storedState = request.cookies.get("fusion_oauth_state")?.value;
  const oauthError = request.nextUrl.searchParams.get("error");

  if (oauthError || !code || !returnedState || !storedState || returnedState !== storedState) {
    return redirectWithStatus(request, "failed");
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const redirectUri = process.env.TWITCH_REDIRECT_URI;
  const broadcasterId = process.env.TWITCH_BROADCASTER_ID;

  if (!clientId || !clientSecret || !redirectUri || !broadcasterId || !process.env.TOKEN_ENCRYPTION_KEY) {
    return redirectWithStatus(request, "not-configured");
  }

  try {
    const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      cache: "no-store",
    });

    if (!tokenResponse.ok) {
      return redirectWithStatus(request, "failed");
    }

    const tokenData = (await tokenResponse.json()) as TwitchTokenResponse;
    if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
      return redirectWithStatus(request, "failed");
    }

    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: "no-store",
    });
    if (!validateResponse.ok) {
      return redirectWithStatus(request, "failed");
    }

    const usersResponse = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Client-Id": clientId,
      },
      cache: "no-store",
    });
    if (!usersResponse.ok) {
      return redirectWithStatus(request, "failed");
    }

    const usersPayload = (await usersResponse.json()) as { data?: TwitchUser[] };
    const twitchUser = usersPayload.data?.[0];
    if (!twitchUser?.id || !twitchUser.login) {
      return redirectWithStatus(request, "failed");
    }

    const sessionToken = createSessionToken();
    const sessionHash = hashSessionToken(sessionToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (twitch_user_id, twitch_login, display_name, avatar_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (twitch_user_id) DO UPDATE SET
           twitch_login = EXCLUDED.twitch_login,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = NOW()
         RETURNING id`,
        [twitchUser.id, twitchUser.login, twitchUser.display_name, twitchUser.profile_image_url || null],
      );
      const userId = userResult.rows[0].id;

      // The service belongs to one configured broadcaster. Viewers may sign in,
      // but they must never be able to create a channel and grant themselves owner access.
      let channelId: string;
      if (twitchUser.id === broadcasterId) {
        const channelResult = await client.query<{ id: string }>(
          `INSERT INTO channels (twitch_broadcaster_id, twitch_login, display_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (twitch_broadcaster_id) DO UPDATE SET
             twitch_login = EXCLUDED.twitch_login,
             display_name = EXCLUDED.display_name,
             updated_at = NOW()
           RETURNING id`,
          [broadcasterId, twitchUser.login, twitchUser.display_name],
        );
        channelId = channelResult.rows[0].id;
      } else {
        const channelResult = await client.query<{ id: string }>(
          "SELECT id FROM channels WHERE twitch_broadcaster_id = $1",
          [broadcasterId],
        );
        if (!channelResult.rows[0]) {
          throw new Error("The configured Fusion broadcaster has not connected Twitch yet.");
        }
        channelId = channelResult.rows[0].id;
      }

      await client.query(
        "INSERT INTO channel_settings (channel_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [channelId],
      );
      await client.query(
        "INSERT INTO queue_state (channel_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [channelId],
      );
      if (twitchUser.id === broadcasterId) {
        await client.query(
          `INSERT INTO channel_roles (channel_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'owner'`,
          [channelId, userId],
        );
      }
      // Only the configured broadcaster needs a persistent Twitch API token.
      // Viewer logins create a short-lived application session, not stored OAuth credentials.
      if (twitchUser.id === broadcasterId) {
        await client.query(
          `INSERT INTO twitch_tokens
             (user_id, access_token_encrypted, refresh_token_encrypted, scopes, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET
             access_token_encrypted = EXCLUDED.access_token_encrypted,
             refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
             scopes = EXCLUDED.scopes,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            userId,
            encryptToken(tokenData.access_token),
            encryptToken(tokenData.refresh_token),
            tokenData.scope || [],
            tokenExpiresAt,
          ],
        );
      }
      await client.query("DELETE FROM sessions WHERE expires_at < NOW()");
      await client.query(
        "INSERT INTO sessions (token_hash, user_id, channel_id, expires_at) VALUES ($1, $2, $3, $4)",
        [sessionHash, userId, channelId, expiresAt],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const response = redirectWithStatus(request, "success");
    response.cookies.set("fusion_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return response;
  } catch {
    return redirectWithStatus(request, "failed");
  }
}
