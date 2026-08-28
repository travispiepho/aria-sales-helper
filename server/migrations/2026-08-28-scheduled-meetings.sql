-- Additive, idempotent schedule-ahead fields on the canonical meetings record.
-- A scheduled row remains the same row when started; no parallel schedule table
-- and no duplicate active meeting are created.
BEGIN;

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_timezone TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_name TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_phone TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_address TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_started_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_call_sid TEXT;

CREATE INDEX IF NOT EXISTS idx_meetings_upcoming_by_rep
  ON meetings (rep_id, scheduled_for ASC)
  WHERE scheduled_for IS NOT NULL AND status = 'active' AND scheduled_started_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_scheduled_call_sid_unique
  ON meetings (scheduled_call_sid)
  WHERE scheduled_call_sid IS NOT NULL;

COMMIT;
