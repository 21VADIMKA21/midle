CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'waiting_for_auth', 'connecting', 'connected', 'reconnecting', 'stopped', 'error')
  ),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
