import { getPool } from "./db";
import { decryptToken, encryptToken } from "./security";

type StoredToken = {
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  expires_at: Date;
};

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string[];
};

export async function getBroadcasterAccessToken(): Promise<string> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Twitch broadcaster integration is not configured");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenResult = await client.query<StoredToken>(
      `SELECT tt.user_id, tt.access_token_encrypted,
              tt.refresh_token_encrypted, tt.expires_at
       FROM channels c
       JOIN channel_roles cr ON cr.channel_id = c.id AND cr.role = 'owner'
       JOIN users u ON u.id = cr.user_id AND u.twitch_user_id = c.twitch_broadcaster_id
       JOIN twitch_tokens tt ON tt.user_id = u.id
       ORDER BY c.created_at ASC
       LIMIT 1
       FOR UPDATE OF tt`,
    );

    const stored = tokenResult.rows[0];
    if (!stored) {
      throw new Error("The broadcaster must sign in to Fusion Music first");
    }

    if (stored.expires_at.getTime() > Date.now() + 5 * 60 * 1000) {
      const accessToken = decryptToken(stored.access_token_encrypted);
      await client.query("COMMIT");
      return accessToken;
    }

    const refreshToken = decryptToken(stored.refresh_token_encrypted);
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

    if (!response.ok) {
      throw new Error("Twitch token refresh failed; broadcaster re-authentication is required");
    }

    const refreshed = (await response.json()) as RefreshResponse;
    if (!refreshed.access_token || !refreshed.expires_in) {
      throw new Error("Twitch returned an incomplete token refresh response");
    }

    const nextRefreshToken = refreshed.refresh_token || refreshToken;
    const nextExpiry = new Date(Date.now() + refreshed.expires_in * 1000);

    await client.query(
      `UPDATE twitch_tokens
       SET access_token_encrypted = $2,
           refresh_token_encrypted = $3,
           scopes = $4,
           expires_at = $5,
           updated_at = NOW()
       WHERE user_id = $1`,
      [
        stored.user_id,
        encryptToken(refreshed.access_token),
        encryptToken(nextRefreshToken),
        refreshed.scope || [],
        nextExpiry,
      ],
    );

    await client.query("COMMIT");
    return refreshed.access_token;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
