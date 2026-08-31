-- 2026-08-31-uploaded-recording-setup-call-choice.sql
--
-- aria_recording_analysis_meeting_type_choice
--
-- Backs an EXPLICIT rep choice of meeting type for the "analyze a
-- recording" (uploaded/pre-recorded) flow, so an uploaded recording can
-- get the same two coaching modes a LIVE call already gets
-- (aria_setup_call_coaching_differentiation, 2026-08-30) — setup-call
-- project-info-collection coaching vs. the full 11-stage in-person
-- walkthrough checklist coaching — WITHOUT relying on the live-call
-- auto-detector (coachingAnalysis.js's isSetupCallPhoneMeeting():
-- `channel === 'phone' && !!call_sid`), which cannot apply here: an
-- uploaded recording's `channel` is always 'uploaded_recording' and it
-- never has a `call_sid` (there is no Twilio/browser call backing it).
--
-- WHY A NEW COLUMN, NOT REUSE/RENAME `is_setup_call_mode`:
--   `is_setup_call_mode` (see GET /api/meetings/:id's shapeMeetingForClient()
--   call site in server.js) is a RESPONSE-ONLY, DERIVED-ON-READ boolean —
--   it is computed fresh from isSetupCallPhoneMeeting(meeting) on every
--   fetch and is never itself a persisted column on `meetings`. There is
--   nothing to "set" on that name; a write endpoint cannot assign a value
--   to a field that isn't a column. This migration instead adds the one
--   thing that WAS missing — a genuinely persisted, explicitly settable
--   field — and server.js's derivation logic is broadened (see
--   coachingAnalysis.js's new isSetupCallMeeting() export) to OR this
--   column in for uploaded-recording meetings, so `is_setup_call_mode` in
--   every API response keeps meaning exactly the same thing it always has
--   ("this meeting should get setup-call coaching"), now computed from
--   whichever signal is correct for that meeting's channel:
--     - phone/browser call  -> auto-detected (channel + call_sid), UNCHANGED
--     - uploaded recording  -> this column, explicitly rep-chosen at
--       creation time (POST /api/uploaded-recordings)
--     - in_person            -> always false, UNCHANGED
--
-- NULLABLE, TRI-STATE BY DESIGN: NULL is a legitimate, meaningful state —
-- "not applicable to this meeting's channel" (in_person, phone) or,
-- transiently, "not yet chosen" for an uploaded recording if a future
-- caller of POST /api/uploaded-recordings somehow omits the (currently
-- REQUIRED — see uploadedRecording.js) field. NULL is never treated as
-- "true"; only an explicit `TRUE` value flips a meeting into setup-call
-- coaching mode. Existing rows before this migration are backfilled to
-- NULL by ADD COLUMN's implicit default, which is exactly correct for
-- every meeting created before this feature existed.
--
-- Applied to live prod DB and mirrored in ensureSessionsTable() per this
-- repo's established migration convention (see 2026-08-30-setup-call-
-- project-info.sql for the same convention on the immediately-prior task).

BEGIN;

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS setup_call_choice BOOLEAN;

COMMIT;

-- Verification query (reference for hand-testing):
--   SELECT id, channel, setup_call_choice FROM meetings WHERE id = '<id>';
