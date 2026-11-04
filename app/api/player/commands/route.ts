import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "../../../../lib/db";
import { getPlayerDevice } from "../../../../lib/player-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let client: PoolClient | null = null;

  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    client = await getPool().connect();
    await client.query("BEGIN");

    await client.query(
      `UPDATE player_commands
       SET status = 'failed', last_error = 'ack_timeout'
       WHERE device_id = $1
         AND status = 'delivered'
         AND attempts >= 5
         AND delivered_at < NOW() - INTERVAL '10 seconds'`,
      [device.id],
    );

    const commands = await client.query<{
      id: string;
      command: string;
      payload: Record<string, unknown>;
      attempts: number;
      created_at: Date;
    }>(
      `WITH candidates AS (
         SELECT pc.id
         FROM player_commands pc
         JOIN player_devices pd ON pd.id = pc.device_id
         WHERE pc.device_id = $1
           AND pd.revoked_at IS NULL
           AND pc.attempts < 5
           AND (
             pc.status = 'pending'
             OR (pc.status = 'delivered' AND pc.delivered_at < NOW() - INTERVAL '10 seconds')
           )
         ORDER BY pc.id
         LIMIT 20
         FOR UPDATE OF pc SKIP LOCKED
       )
       UPDATE player_commands pc
       SET status = 'delivered',
           delivered_at = NOW(),
           attempts = attempts + 1
       FROM candidates
       WHERE pc.id = candidates.id
       RETURNING pc.id, pc.command, pc.payload, pc.attempts, pc.created_at`,
      [device.id],
    );

    await client.query("COMMIT");

    return NextResponse.json({
      device: { id: device.id, name: device.name },
      commands: commands.rows.map((command) => ({
        id: command.id,
        command: command.command,
        payload: command.payload,
        attempts: command.attempts,
        createdAt: command.created_at,
      })),
      polledAt: new Date().toISOString(),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
    }
    return NextResponse.json({ error: "Player command service is temporarily unavailable." }, { status: 503 });
  } finally {
    client?.release();
  }
}
