-- 2026-08-18-objections-rebuttals.sql
--
-- Adds the "Objections" library (Troy Hacker's request, tracked as the
-- "Rebuttal list to objections" line item in HighPriorityTodos): a
-- standalone reference of customer objections, each holding one or more
-- rep-submitted rebuttals. This is a browsing/reference library ONLY —
-- it is not wired into the live meeting/coaching pipeline (that pipeline
-- already has its own, unrelated stub in objectionDetection.js /
-- coachingAnalysis.js's generateRebuttal(); this feature is deliberately
-- separate, see this task's report for the in-meeting-surfacing
-- recommendation left for a future pass).
--
-- Schema conventions followed (matching existing tables in this file /
-- migrate.js's schema, e.g. customers/meetings):
--   - UUID PRIMARY KEY DEFAULT gen_random_uuid() (same as users/customers/
--     meetings/voice_prints/coaching_snapshots)
--   - created_at/updated_at TIMESTAMPTZ DEFAULT NOW() (no soft-delete here
--     — unlike users.deactivated_at, there is no FK-attribution reason to
--     keep a deleted objection/rebuttal row around; a rep who deletes a bad
--     objection or rebuttal expects it actually gone, and nothing else
--     references objections/rebuttals by id the way meetings.rep_id does
--     for users)
--   - created_by UUID REFERENCES users(id), same pattern as
--     customers.created_by / invites.invited_by
--   - No tenant/account scoping column exists anywhere else in this schema
--     (checked: users/customers/meetings have no account_id/tenant_id) —
--     this is a single-tenant app (CertaPro Grand Haven only), so none is
--     added here either, consistent with the rest of the codebase.
--
-- rebuttals.objection_id has ON DELETE CASCADE: deleting an objection is
-- expected to delete its rebuttals too (a rebuttal with no parent
-- objection is meaningless), same rationale as voice_prints' ON DELETE
-- CASCADE on user_id.
--
-- Ordering: rebuttals are listed by created_at ASC (oldest/first-added
-- first) — no explicit sort_order column, matching this codebase's existing
-- preference for created_at-based ordering everywhere else (meetings,
-- coaching_snapshots, invites all order by created_at, none use a manual
-- sort-order column).
--
-- ⚠️⚠️⚠️ MANUAL STEP REQUIRED BEFORE THIS FEATURE WORKS IN PROD ⚠️⚠️⚠️
-- This repo's migrations are NOT run automatically on deploy (see
-- migrate.js's header + the 2026-08-17 incident where code shipped
-- referencing not-yet-existing columns and had to be applied by hand).
-- This file must be run by hand against the prod Neon DB (`node migrate.js`
-- reads migrate.js's own inline schema, NOT this file — the actual applied
-- mechanism in this codebase is running the CREATE/ALTER statements below
-- directly, e.g. via `psql "$DATABASE_URL" -f
-- server/migrations/2026-08-18-objections-rebuttals.sql`) before the
-- Objections tab's API routes are hit in prod, or every request will 500
-- with a "relation does not exist" error. THIS TASK DID NOT APPLY IT — see
-- the task report.

BEGIN;

CREATE TABLE IF NOT EXISTS objections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  category TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rebuttals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objection_id UUID NOT NULL REFERENCES objections(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rebuttals_objection_id_created_at_idx
  ON rebuttals (objection_id, created_at ASC);

COMMIT;

-- Verification query (reference for hand-testing):
--   SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('objections', 'rebuttals');
--   -- expected: both rows present
