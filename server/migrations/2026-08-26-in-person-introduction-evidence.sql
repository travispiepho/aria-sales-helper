-- Persist audit evidence for introduction-derived in-person speaker labels.
-- Additive and idempotent. Values reference existing transcript segment rows;
-- this feature creates no additional recording and stores no duplicate audio.
BEGIN;
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS speaker_label_evidence JSONB NOT NULL DEFAULT '{}';
COMMIT;
