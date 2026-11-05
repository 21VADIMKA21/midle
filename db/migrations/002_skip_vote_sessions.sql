-- Time-limited moderator-started skip voting sessions.
CREATE TABLE IF NOT EXISTS skip_vote_sessions (
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_id, request_id)
);
CREATE INDEX IF NOT EXISTS skip_vote_sessions_expiry_idx ON skip_vote_sessions(expires_at);
