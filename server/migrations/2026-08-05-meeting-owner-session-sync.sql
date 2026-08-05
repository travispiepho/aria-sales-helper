-- 2026-08-05-meeting-owner-session-sync.sql
--
-- PROPOSED / SKETCH ONLY — NOT APPLIED TO PRODUCTION. Written to support the
-- "ARIA Live Meeting Sync (mobile → web)" feature (see server.js's
-- "Live meeting sync" comment block near activeMeetingObservers / the
-- /api/meetings/active-sync and /meetings/:id/observe routes for the full
-- write-up).
--
-- Purpose: track WHICH logged-in session started a given meeting, so that:
--   1. Any OTHER session belonging to the SAME user_id (a second browser
--      tab, a different device also logged in as that rep) can be told
--      "there's an active meeting for your account" via
--      GET /api/meetings/active-sync, and
--   2. Only that ORIGINATING session can end/finalize the meeting — a
--      PATCH /api/meetings/:id request that tries to transition `status`
--      to a terminal value ('completed'/'cancelled') from a DIFFERENT
--      session than the one recorded here is rejected with 403, even if
--      the request otherwise has valid auth for the same rep_id.
--
-- This intentionally does NOT invent a new sessions/presence table — it
-- adds ONE nullable column to the existing `meetings` table, reusing the
-- existing `sessions` table's `id` values (session cookie / mobile
-- secure-store sessionId) as the "which session owns this" identifier.
-- No FK constraint to sessions(id) is added on purpose: a session row can
-- be deleted on logout (see server.js's deleteSession()) or simply expire
-- (sessions are never physically deleted on expiry, only filtered by
-- `expires_at > NOW()` at lookup time) — in either case the meeting's
-- owner_session_id staying around as a plain, non-FK string is harmless:
-- comparisons still work correctly (a request from that no-longer-valid
-- session can't authenticate anyway; a request from any OTHER session
-- simply won't match, same as before), and there's no dangling-FK cleanup
-- burden to reason about.
--
-- Backward compatibility: existing (pre-this-migration) meetings will have
-- owner_session_id = NULL. server.js's enforcement check treats NULL as
-- "no recorded owner — permissive" (falls back to the existing rep_id-only
-- check), so this migration introduces zero behavior change for any
-- meeting already in flight when it's applied, and zero risk of locking
-- out a legitimate rep from ending a meeting created before this shipped.

BEGIN;

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS owner_session_id TEXT;

-- `origin_client` records WHICH APP created the meeting ('mobile' | 'web').
-- Needed to scope this v1 sync feature to MOBILE-ORIGINATED meetings only,
-- per Troy's explicit instruction not to build the reverse (web→mobile)
-- direction yet — GET /api/sync's catch-up query and the
-- notifyUserSyncMeetingStarted() call in POST /api/meetings both filter on
-- origin_client = 'mobile'. Defaults to 'web' for any INSERT that doesn't
-- specify it (matches the pre-existing behavior where all meetings were
-- effectively web-or-in-person-app in-person meetings before this pass).
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS origin_client TEXT NOT NULL DEFAULT 'web'
    CHECK (origin_client IN ('mobile', 'web'));

-- Indexed: GET /api/sync's connect-time catch-up query and
-- GET /api/meetings/active-sync both filter on
-- (rep_id, status, origin_client) to find "is there an active mobile
-- meeting for this user right now" — a partial index on just the active-
-- mobile subset keeps that lookup fast without indexing the (much larger,
-- and never queried this way) completed/cancelled/interrupted history.
CREATE INDEX IF NOT EXISTS idx_meetings_active_mobile_by_rep
  ON meetings (rep_id)
  WHERE status = 'active' AND origin_client = 'mobile';

COMMIT;

-- ─── Why this is safe to apply later without much risk ────────────────────
-- Single nullable ADD COLUMN IF NOT EXISTS on an existing table, same
-- pattern already used elsewhere in this codebase (see server.js's
-- `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_labels JSONB
-- DEFAULT '{}'` in ensureSessionsTable(), and the phone-channel/voice-print
-- migrations in this same directory). No existing row's data is touched;
-- every existing row simply gets owner_session_id = NULL, which is the
-- explicitly-handled "permissive fallback" case in server.js — verified
-- against a local test Postgres instance in this task's own test run (see
-- accompanying report), NOT against the live Neon prod DATABASE_URL.
