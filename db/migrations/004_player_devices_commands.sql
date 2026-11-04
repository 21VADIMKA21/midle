-- Local desktop player devices and durable command delivery.

CREATE TABLE IF NOT EXISTS player_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS player_devices_channel_active_idx
  ON player_devices(channel_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE player_sessions
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES player_devices(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS player_sessions_device_id_idx
  ON player_sessions(device_id)
  WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS player_commands (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES player_devices(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  command TEXT NOT NULL CHECK (
    command IN ('play', 'pause', 'resume', 'skip', 'set_volume', 'resync_library')
  ),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'acknowledged', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS player_commands_poll_idx
  ON player_commands(device_id, status, id);

CREATE INDEX IF NOT EXISTS player_commands_channel_created_idx
  ON player_commands(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS player_events (
  event_id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES player_devices(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('started', 'finished', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_events_channel_created_idx
  ON player_events(channel_id, created_at DESC);
