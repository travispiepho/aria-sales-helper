-- 2026-08-17-meeting-recording-columns.sql
--
-- Adds columns to `meetings` to persist Twilio call-recording metadata, per
-- Gabe Bass's request: "I want recording to automatically start on ARIA
-- when the customer answers their phone."
--
-- Companion to server/telephony.js's `/telephony/outbound-answer`
-- (record="record-from-answer-dual" now added to its <Dial>) and the new
-- `/telephony/recording-status` recordingStatusCallback route, which writes
-- these columns once Twilio reports the recording as available.
--
-- Same idempotent ALTER-table style as the existing
-- 2026-08-04-phone-channel-columns.sql (call_sid/channel/disclosure_*) and
-- 2026-08-05-meeting-auto-titled-flag.sql — plain SQL, no migration
-- framework, safe to re-run.

BEGIN;

-- Twilio's Recording resource SID (RE...), the durable handle for fetching
-- the recording via the REST API / recording media URL. Nullable: not
-- every meeting is a phone call, and even phone-call meetings may complete
-- without ever producing a recording (no-answer, busy, call failed before
-- the customer leg was ever answered).
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS recording_sid TEXT;

-- Twilio's RecordingUrl as delivered on the recordingStatusCallback /
-- Dial-action payload (base .json/.mp3/.wav media URL, auth-gated by the
-- account's Twilio credentials — do not treat as a public link).
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS recording_url TEXT;

-- Twilio RecordingStatus lifecycle value as last reported
-- (in-progress | completed | absent | failed) — mirrors
-- recordingStatusCallbackEvent's possible payload values.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS recording_status TEXT;

CREATE INDEX IF NOT EXISTS idx_meetings_recording_sid ON meetings(recording_sid) WHERE recording_sid IS NOT NULL;

COMMIT;

-- ─── Why this is safe to apply ──────────────────────────────────────────
-- All three additions are nullable ADD COLUMN IF NOT EXISTS on the existing
-- `meetings` table (same pattern as the phone-channel and disclosure
-- columns above it) — zero backfill required, zero impact on existing rows
-- or non-phone (in_person) meetings, which will simply carry NULLs here
-- forever.
