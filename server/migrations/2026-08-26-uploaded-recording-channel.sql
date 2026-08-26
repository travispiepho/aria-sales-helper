-- Add uploaded_recording to the existing meetings.channel contract without
-- changing any existing row. No source-audio column/table is created: only
-- the existing meeting/transcript/coaching/summary records are persisted.
BEGIN;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_channel_check;
ALTER TABLE meetings
  ADD CONSTRAINT meetings_channel_check
  CHECK (channel IN ('phone', 'in_person', 'uploaded_recording'));
COMMIT;
