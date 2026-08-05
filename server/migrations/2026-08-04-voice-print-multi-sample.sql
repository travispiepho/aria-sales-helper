-- 2026-08-04-voice-print-multi-sample.sql
--
-- PROPOSED MIGRATION — WRITTEN BUT NOT APPLIED. Do not run against
-- production without a deliberate decision to do so (see
-- memory/aria-pyannote-twilio-scaffold-2026-08-04.md for the safety
-- reasoning that was used to decide NOT to auto-apply this).
--
-- Repo convention note: this codebase has no dedicated migration
-- framework/folder as of 2026-08-04 — the only prior precedent is
-- app/server/migrate.js (a single idempotent `CREATE TABLE IF NOT EXISTS` /
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` script run manually via
-- `npm run migrate`) plus a few inline `ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS` statements added directly inside server.js's ensureSessionsTable()
-- for later additions (see server.js lines ~129-167). This file follows
-- that same idempotent-SQL style so it could be pasted into either location
-- later, but is kept as a standalone .sql file per the task's instruction
-- to not invent a new migration framework where none exists.
--
-- Purpose: support multi-sample voiceprint enrollment (needed regardless of
-- vendor — pyannoteAI or otherwise — per 2026-08-02 memory notes and
-- memory/voice-fingerprinting-comparison-2026-08-03.md, which notes
-- pyannoteAI's own voiceprints are opaque blobs you're expected to store
-- yourself, and nothing stops storing multiple per user_id once the
-- UNIQUE(user_id) constraint is gone).
--
-- Approach chosen: ADD a new `voice_print_samples` table rather than
-- altering `voice_prints` in place. Rationale:
--   - `voice_prints` currently stores homegrown spectral features (see
--     voiceFeatures.js) used by the existing in-person rep-match flow.
--     Changing its shape risks the live in-person voice-matching feature,
--     which this task was explicitly told not to destabilize.
--   - A new table lets multi-sample enrollment (needed for pyannoteAI
--     voiceprints, which are just opaque base64 blobs, a different shape
--     entirely from the spectral `features` JSONB column already in use)
--     land without touching the existing table's columns or the code that
--     reads them (server.js lines ~371, 386, 396).
--   - `voice_prints` keeps its current role (single "current best" spectral
--     fingerprint used by the live in-person matcher) unless/until that
--     matcher itself is migrated to pyannoteAI voiceprints — a separate,
--     larger change explicitly out of scope here.
--
-- This migration still drops voice_prints' UNIQUE(user_id) constraint as
-- requested, since the task explicitly asks for both: (a) dropping that
-- constraint, and (b) a multi-sample-capable structure. Dropping the
-- constraint alone does not break the existing single-row-per-user code
-- paths (they use `WHERE user_id = $1` without relying on the DB enforcing
-- uniqueness — see server.js:371,386,396 — application logic already
-- tolerates zero-or-one rows there and would simply need updating to
-- tolerate zero-or-many if this ships, which is a small, separate
-- follow-up, not required for THIS migration to be safe to apply).

BEGIN;

-- 1. Drop the UNIQUE(user_id) constraint on voice_prints, enabling
--    multiple enrollment samples per user in that table directly if ever
--    desired (belt-and-suspenders alongside the new table below — some
--    future code path may still want "all spectral samples for this rep").
ALTER TABLE voice_prints DROP CONSTRAINT IF EXISTS voice_prints_user_id_key;

-- 2. New table for multi-sample voiceprint enrollment (vendor-agnostic:
--    works for pyannoteAI base64 voiceprint blobs, or any future vendor's
--    equivalent opaque enrollment artifact). `sample_index` lets a caller
--    order/label multiple samples per user without relying on created_at
--    ordering alone.
CREATE TABLE IF NOT EXISTS voice_print_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sample_index INTEGER NOT NULL DEFAULT 0,
  vendor TEXT NOT NULL DEFAULT 'pyannoteai' CHECK (vendor IN ('pyannoteai', 'homegrown')),
  voiceprint_blob TEXT,              -- opaque vendor voiceprint (e.g. pyannoteAI base64 string)
  features JSONB,                    -- homegrown spectral features (voiceFeatures.js shape), if vendor='homegrown'
  duration_ms INTEGER,
  source_audio_note TEXT,            -- free-text provenance note (e.g. "enrollment call 2026-08-10"), not the audio itself
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, sample_index)
);

CREATE INDEX IF NOT EXISTS idx_voice_print_samples_user_id ON voice_print_samples(user_id);

COMMIT;

-- ─── Safety check queries to run BEFORE applying in a real environment ────
-- SELECT COUNT(*) FROM voice_prints;
-- SELECT conname FROM pg_constraint WHERE conrelid = 'voice_prints'::regclass;
-- (As of 2026-08-04, verified via a live read-only query against the Neon
-- prod DB: voice_prints has exactly 2 rows. Dropping UNIQUE(user_id) on a
-- 2-row table is low-risk/non-destructive — it only REMOVES a constraint,
-- it does not alter or delete any existing row. See the accompanying report
-- for the final decision on whether this was actually applied.)
