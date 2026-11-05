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

type OAuthFlow = "viewer" | "owner";

function redirectWithStatus(request: NextRequest, status: string, flow: OAuthFlow) {
  const target = new URL(flow === "owner" ? "/dashboard" : "/", process.env.APP_URL || request.nextUrl.origin);
  target.searchParams.set("auth", status);
  const response = NextResponse.redirect(target);
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: 0,
  };
  response.cookies.set("fusion_oauth_state", "", cookieOptions);
  response.cookies.set("fusion_oauth_flow", "", cookieOptions);
  return response;
}

export async function GET(request: NextRequest) {
  const flow = request.cookies.get("fusion_oauth_flow")?.value as OAuthFlow | undefined;
  const code = request.nextUrl.searchParams.get("code");
  const returnedState = request.nextUrl.searchParams.get("state");
  const storedState = request.cookies.get("fusion_oauth_state")?.value;
  const oauthError = request.nextUrl.searchParams.get("error");

  if (
    (flow !== "viewer" && flow !== "owner") ||
    oauthError ||
    !code ||
    !returnedState ||
    !storedState ||
    returnedState !== storedState
  ) {
    return redirectWithStatus(request, "failed", flow === "owner" ? "owner" : "viewer");
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const redirectUri = process.env.TWITCH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return redirectWithStatus(request, "not-configured", flow);
  }
  if (flow === "owner" && !process.env.TOKEN_ENCRYPTION_KEY) {
    return redirectWithStatus(request, "not-configured", flow);
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
      signal: AbortSignal.timeout(10_000),

      cache: "no-store",
    });

    if (!tokenResponse.ok) return redirectWithStatus(request, "failed", flow);

    const tokenData = (await tokenResponse.json()) as TwitchTokenResponse;
    if (!tokenData.access_token || !tokenData.expires_in) {
      return redirectWithStatus(request, "failed", flow);
    }

    if (
      flow === "owner" &&
      (!tokenData.refresh_token ||
        !tokenData.scope?.includes("moderator:read:chatters") ||
        !tokenData.scope.includes("moderation:read") ||
        !tokenData.scope.includes("user:read:chat") ||
        !tokenData.scope.includes("user:write:chat"))
    ) {
      return redirectWithStatus(request, "scope-missing", flow);
    }

    const validateResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: "Bearer " + tokenData.access_token },
      signal: AbortSignal.timeout(10_000),

      cache: "no-store",
    });
    if (!validateResponse.ok) return redirectWithStatus(request, "failed", flow);

    const usersResponse = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: "Bearer " + tokenData.access_token,
        "Client-Id": clientId,
      },
      signal: AbortSignal.timeout(10_000),

      cache: "no-store",
    });
    if (!usersResponse.ok) return redirectWithStatus(request, "failed", flow);

    const usersPayload = (await usersResponse.json()) as { data?: TwitchUser[] };
    const twitchUser = usersPayload.data?.[0];
    if (!twitchUser?.id || !twitchUser.login) {
      return redirectWithStatus(request, "failed", flow);
    }

    const sessionToken = createSessionToken();
    const sessionHash = hashSessionToken(sessionToken);
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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

      let channel = (await client.query<{
        id: string;
        twitch_broadcaster_id: string;
      }>(
        "SELECT id, twitch_broadcaster_id FROM channels ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
      )).rows[0];

      if (flow === "owner") {
        if (channel && channel.twitch_broadcaster_id !== twitchUser.id) {
          await client.query("ROLLBACK");
          return redirectWithStatus(request, "not-owner", flow);
        }

        if (!channel) {
          const created = await client.query<{ id: string; twitch_broadcaster_id: string }>(
            `INSERT INTO channels (twitch_broadcaster_id, twitch_login, display_name)
             VALUES ($1, $2, $3)
             RETURNING id, twitch_broadcaster_id`,
            [twitchUser.id, twitchUser.login, twitchUser.display_name],
          );
          channel = created.rows[0];
        } else {
          await client.query(
            `UPDATE channels
             SET twitch_login = $2, display_name = $3, updated_at = NOW()
             WHERE id = $1`,
            [channel.id, twitchUser.login, twitchUser.display_name],
          );
        }
      } else if (!channel) {
        await client.query("ROLLBACK");
        return redirectWithStatus(request, "setup-required", flow);
      }

      const channelId = channel.id;

      await client.query(
        "INSERT INTO channel_settings (channel_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [channelId],
      );
      await client.query(
        "INSERT INTO queue_state (channel_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [channelId],
      );

      if (channel.twitch_broadcaster_id === twitchUser.id) {
        await client.query(
          `INSERT INTO channel_roles (channel_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'owner'`,
          [channelId, userId],
        );

        if (flow === "owner") {
          const tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in || 0) * 1000);
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
              encryptToken(tokenData.refresh_token as string),
              tokenData.scope || [],
              tokenExpiresAt,
            ],
          );
        }
      }

      await client.query("DELETE FROM sessions WHERE expires_at < NOW()");
      await client.query(
        "INSERT INTO sessions (token_hash, user_id, channel_id, expires_at) VALUES ($1, $2, $3, $4)",
        [sessionHash, userId, channelId, sessionExpiresAt],
      );

      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
      throw error;
    } finally {
      client.release();
    }

    const response = redirectWithStatus(request, "success", flow);
    response.cookies.set("fusion_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return response;
  } catch (error) {
    console.error("[twitch-oauth] Callback failed:", error instanceof Error ? error.message : String(error));
    return redirectWithStatus(request, "failed", flow);
  }
}
