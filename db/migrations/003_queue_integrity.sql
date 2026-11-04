-- Enforce a single active track per channel at the database layer.
-- This prevents concurrent player workers from marking two tracks as playing.

CREATE UNIQUE INDEX IF NOT EXISTS requests_one_playing_per_channel_idx
  ON requests(channel_id)
  WHERE status = 'playing';

CREATE INDEX IF NOT EXISTS votes_request_count_idx
  ON votes(channel_id, request_id, vote);
