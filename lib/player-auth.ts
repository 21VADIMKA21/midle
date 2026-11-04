import type { NextRequest } from "next/server";
import { query } from "./db";
import { hashSessionToken } from "./security";

export type PlayerDevice = {
  id: string;
  channelId: string;
  name: string;
};

export async function getPlayerDevice(
  request: NextRequest,
): Promise<PlayerDevice | null> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token || token.length < 32 || token.length > 256) {
    return null;
  }

  const result = await query<{
    id: string;
    channel_id: string;
    name: string;
  }>(
    `SELECT id, channel_id, name
     FROM player_devices
     WHERE token_hash = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
  };
}
