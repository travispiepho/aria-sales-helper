-- Persist provenance for introduction-derived in-person speaker labels.
-- Additive and idempotent. Values contain method/role/confidence plus IDs and
-- timestamps referencing existing transcript rows; no transcript or audio copy.
BEGIN;
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS speaker_label_evidence JSONB NOT NULL DEFAULT '{}';
COMMIT;
