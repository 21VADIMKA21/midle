CREATE INDEX IF NOT EXISTS twitch_chat_commands_user_cooldown_idx
  ON twitch_chat_commands(channel_id, chatter_user_id, command, created_at DESC);
