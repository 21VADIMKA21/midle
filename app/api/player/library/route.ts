import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "../../../../lib/db";
import { getPlayerDevice } from "../../../../lib/player-auth";
import { invalidateQueueCache } from "../../../../lib/queue-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const FORMATS = new Set(["mp3", "m4a", "wav", "ogg", "flac"]);

type LibraryTrack = {
  hash: string;
  title: string;
  artist: string;
  durationSeconds: number | null;
  album: string | null;
  format: string;
  fileSize: number;
};

function validateTrack(value: unknown): LibraryTrack | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;

  if (
    typeof item.hash !== "string" || !HASH_PATTERN.test(item.hash) ||
    typeof item.title !== "string" || !item.title.trim() || item.title.length > 200 ||
    typeof item.artist !== "string" || !item.artist.trim() || item.artist.length > 200 ||
    typeof item.format !== "string" || !FORMATS.has(item.format.toLowerCase()) ||
    typeof item.fileSize !== "number" || !Number.isSafeInteger(item.fileSize) || item.fileSize < 0 || item.fileSize > 2_000_000_000
  ) {
    return null;
  }

  const durationSeconds = item.durationSeconds === null
    ? null
    : typeof item.durationSeconds === "number" &&
      Number.isInteger(item.durationSeconds) &&
      item.durationSeconds > 0 &&
      item.durationSeconds <= 86_400
      ? item.durationSeconds
      : undefined;

  if (durationSeconds === undefined) return null;

  const album = typeof item.album === "string" ? item.album.trim().slice(0, 200) || null : null;

  return {
    hash: item.hash.toLowerCase(),
    title: item.title.trim(),
    artist: item.artist.trim(),
    durationSeconds,
    album,
    format: item.format.toLowerCase(),
    fileSize: item.fileSize,
  };
}

export async function POST(request: NextRequest) {
  try {
    const device = await getPlayerDevice(request);
    if (!device) {
      return NextResponse.json({ error: "Invalid or revoked player token." }, { status: 401 });
    }

    const body = await request.json().catch(() => null) as { tracks?: unknown } | null;
    if (!Array.isArray(body?.tracks) || body.tracks.length > 2000) {
      return NextResponse.json({ error: "tracks must be an array with no more than 2,000 entries." }, { status: 400 });
    }

    const unique = new Map<string, LibraryTrack>();
    for (const value of body.tracks) {
      const track = validateTrack(value);
      if (!track) {
        return NextResponse.json({ error: "A library track has invalid metadata." }, { status: 400 });
      }
      unique.set(track.hash, track);
    }

    const tracks = [...unique.values()];
    const totalBytes = tracks.reduce((sum, track) => sum + track.fileSize, 0);

    const client: PoolClient = await getPool().connect();
    try {
      await client.query("BEGIN");

      const deviceLock = await client.query(
        "SELECT id FROM player_devices WHERE id = $1 AND channel_id = $2 AND revoked_at IS NULL FOR UPDATE",
        [device.id, device.channelId],
      );
      if (!deviceLock.rowCount) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Player device has been revoked." }, { status: 401 });
      }

      await client.query(
        "UPDATE tracks SET is_available = FALSE WHERE provider = 'local_library'",
      );

      for (let offset = 0; offset < tracks.length; offset += 200) {
        const batch = tracks.slice(offset, offset + 200);
        const values: unknown[] = [];
        const placeholders = batch.map((track, index) => {
          const base = index * 6;
          values.push(
            track.hash,
            track.title,
            track.artist,
            track.durationSeconds,
            JSON.stringify({
              album: track.album,
              format: track.format,
              fileSize: track.fileSize,
            }),
            true,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, NOW())`;
        });

        await client.query(
          `INSERT INTO tracks
             (provider, provider_track_id, title, artist, duration_seconds, metadata, is_available, last_seen_at)
           VALUES ${placeholders.map((placeholder) => placeholder.replace(/^\(/, "('local_library', ")).join(", ")}
           ON CONFLICT (provider, provider_track_id) DO UPDATE SET
             title = EXCLUDED.title,
             artist = EXCLUDED.artist,
             duration_seconds = EXCLUDED.duration_seconds,
             metadata = EXCLUDED.metadata,
             is_available = TRUE,
             last_seen_at = NOW()`,
          values,
        );
      }

      const failedRequests = await client.query(
        `UPDATE requests r
         SET status = 'failed', rejection_reason = 'local_file_missing', updated_at = NOW()
         FROM tracks t
         WHERE r.track_id = t.id
           AND r.channel_id = $1
           AND r.status = 'queued'
           AND t.provider = 'local_library'
           AND t.is_available = FALSE`,
        [device.channelId],
      );

      await client.query(
        `INSERT INTO player_library_syncs (device_id, channel_id, synced_at, track_count, total_bytes)
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (device_id) DO UPDATE SET
           synced_at = NOW(),
           track_count = EXCLUDED.track_count,
           total_bytes = EXCLUDED.total_bytes`,
        [device.id, device.channelId, tracks.length, totalBytes],
      );

      await client.query(
        `INSERT INTO audit_log (channel_id, action, details)
         VALUES ($1, 'player.library.synced', $2::jsonb)`,
        [device.channelId, JSON.stringify({ trackCount: tracks.length, totalBytes, failedRequests: failedRequests.rowCount || 0 })],
      );

      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection may already be lost */ }
      throw error;
    } finally {
      client.release();
    }

    const broadcasterId = process.env.TWITCH_BROADCASTER_ID;
    if (broadcasterId) invalidateQueueCache(broadcasterId);

    return NextResponse.json({
      success: true,
      trackCount: tracks.length,
      totalBytes,
      syncedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: "Local library sync is temporarily unavailable." }, { status: 503 });
  }
}
