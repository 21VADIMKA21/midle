import { NextRequest, NextResponse } from "next/server";
import { query } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const search = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 100);
  const pattern = search.replace(/[\\%_]/g, "\\$&");
  const result = await query<{
    id: string;
    title: string;
    artist: string;
    duration_seconds: number | null;
    metadata: { album?: string | null; format?: string } | null;
  }>(
    `SELECT id, title, artist, duration_seconds, metadata
     FROM tracks
     WHERE provider = 'local_library'
       AND is_available = TRUE
       AND ($1 = '' OR title ILIKE '%' || $2 || '%' ESCAPE '\\'
                       OR artist ILIKE '%' || $2 || '%' ESCAPE '\\')
     ORDER BY lower(title), lower(artist)
     LIMIT 50`,
    [search, pattern],
  );

  return NextResponse.json({
    tracks: result.rows.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      durationSeconds: track.duration_seconds,
      album: track.metadata?.album || null,
    })),
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
