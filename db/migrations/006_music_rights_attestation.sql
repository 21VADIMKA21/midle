-- Record the channel owner's explicit confirmation that every local library
-- track submitted to Fusion Music is cleared for Twitch live broadcasting.

ALTER TABLE channel_settings
  ADD COLUMN IF NOT EXISTS music_rights_confirmed_at TIMESTAMPTZ;

ALTER TABLE channel_settings
  ADD COLUMN IF NOT EXISTS music_rights_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;
