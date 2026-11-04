-- Idempotency ledger for Twitch EventSub chat command notifications.
-- Only command messages are recorded, not the entire chat transcript.

CREATE TABLE IF NOT EXISTS twitch_chat_commands (
  event_id TEXT PRIMARY KEY,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  chatter_user_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('track', 'skip')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS twitch_chat_commands_channel_created_idx
  ON twitch_chat_commands(channel_id, created_at DESC);
