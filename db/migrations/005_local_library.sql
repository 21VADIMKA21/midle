-- Track availability and metadata for owner-curated local libraries.

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS tracks_local_catalog_search_idx
  ON tracks(provider, is_available, lower(title), lower(artist));

CREATE TABLE IF NOT EXISTS player_library_syncs (
  device_id UUID PRIMARY KEY REFERENCES player_devices(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  track_count INTEGER NOT NULL DEFAULT 0 CHECK (track_count >= 0),
  total_bytes BIGINT NOT NULL DEFAULT 0 CHECK (total_bytes >= 0)
);
