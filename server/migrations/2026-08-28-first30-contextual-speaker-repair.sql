-- Exactly-once first-30-media-second contextual speaker repair metadata.
-- Additive/idempotent: no existing text, timestamps, audio, or labels are rewritten.
BEGIN;
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS media_time_ms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first30_speaker_repair JSONB NOT NULL DEFAULT '{}';
ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS media_start_ms INTEGER,
  ADD COLUMN IF NOT EXISTS media_end_ms INTEGER,
  ADD COLUMN IF NOT EXISTS speaker_slot INTEGER;
COMMIT;
