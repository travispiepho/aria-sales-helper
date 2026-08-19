-- 2026-08-04-phone-channel-columns.sql
--
-- PROPOSED / SKETCH ONLY — NOT APPLIED. Written to document how a phone-
-- call "meeting" would relate to the existing meetings/customers tables per
-- the Skill Two spec's "one continuous timeline" mandate
-- (memory/skill-two-phone-extension-spec-2026-08-03.md Section 5).
--
-- This intentionally does NOT invent a parallel/disconnected data model —
-- it minimally extends the existing `meetings` table (already shared by
-- in-person visits) with channel-tagging + a Twilio call identifier, exactly
-- as recommended in the spec's Section 5.2 ("Proposed schema"), which this
-- file mirrors directly rather than re-deriving independently:
--
--   > `meetings` — add `channel TEXT NOT NULL DEFAULT 'in_person' CHECK
--   > (channel IN ('phone','in_person'))` (default is factually correct for
--   > all existing rows — Skill One had no phone capability) and
--   > `opportunity_id UUID REFERENCES opportunities(id)`, nullable.
--
-- The spec's `opportunities` table (Section 5.2) is a LARGER, separately-
-- scoped decision (top-level entity spanning multiple meetings/calls) that
-- this scaffolding task was not asked to implement — it's noted here only
-- so the `channel`/`call_sid` additions below are visibly consistent with
-- that eventual direction, not contradicting it. Do not apply the
-- `opportunities` table from this file; it is not created here.
--
-- Repo convention note: same idempotent-ALTER style as
-- 2026-08-04-voice-print-multi-sample.sql and the existing inline
-- migrations in server.js's ensureSessionsTable(). No migration framework
-- exists in this repo (see that file's header note) — plain SQL only.

BEGIN;

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'in_person'
    CHECK (channel IN ('phone', 'in_person'));

-- Twilio's CallSid uniquely identifies one call leg; nullable because
-- in_person meetings will never have one, and a phone meeting row may be
-- created (e.g. from the /telephony/voice webhook) slightly before the
-- CallSid is confirmed in some call-flow variants.
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS call_sid TEXT;

CREATE INDEX IF NOT EXISTS idx_meetings_call_sid ON meetings(call_sid) WHERE call_sid IS NOT NULL;

-- Consent audit-trail columns, per the REQUIRED pre-launch consent/legal
-- decision flagged in telephony.js and the spec's Section 4.3. These are
-- structural placeholders for that audit trail — the actual consent-flow
-- logic that WRITES these fields is explicitly NOT implemented as part of
-- this scaffolding task (see telephony.js's consent TODO block).
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS disclosure_method TEXT
    CHECK (disclosure_method IN ('automated_audio', 'rep_spoken_fallback', 'none_logged'));
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS disclosure_played_at TIMESTAMPTZ;

COMMIT;

-- ─── Why this is safe to apply later without much risk ────────────────────
-- All three additions are nullable-or-defaulted ADD COLUMN IF NOT EXISTS on
-- an existing table already handled this way elsewhere in the codebase
-- (see server.js's `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS
-- speaker_labels JSONB DEFAULT '{}'`, same pattern). `channel` defaults to
-- 'in_person' so every existing row remains correctly tagged with zero
-- backfill needed (Skill One never had phone capability, so this default is
-- factually accurate for 100% of current rows, not just a placeholder).
