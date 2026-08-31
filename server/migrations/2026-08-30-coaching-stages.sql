-- 2026-08-30-coaching-stages.sql
--
-- Refactor-to-data-driven for the sales-process "Stage" list currently
-- hardcoded as STAGE_ORDER in web/src/components/CoachingPanel.tsx (an
-- array of 11 machine keys with no admin UI to view or edit it, and no
-- backend persistence). Adds the new admin-editable "Coaching" nav tab
-- (aria_coaching_stages_admin_tab task).
--
-- Schema conventions followed (matching objections/rebuttals in
-- 2026-08-18-objections-rebuttals.sql, the closest existing analogue):
--   - UUID PRIMARY KEY DEFAULT gen_random_uuid() (same as users/customers/
--     meetings/objections/rebuttals)
--   - created_at/updated_at TIMESTAMPTZ DEFAULT NOW()
--   - No tenant/account scoping column (single-tenant app, consistent with
--     the rest of the schema)
--
-- UNLIKE objections/rebuttals, this table is intentionally NOT a free-for-
-- all shared team library: stage ORDER is load-bearing (CoachingPanel.tsx's
-- progress-percentage math is `stageIndex / STAGE_ORDER.length`, sourced
-- from these rows' `sort_order` once this migration ships), so every row
-- needs an explicit sort_order column rather than relying on created_at
-- ordering the way objections/rebuttals do. `key` is the machine-safe
-- identifier written into meetings.coaching_snapshots' `stage.current` by
-- the LLM coaching pass (server.js's runCoachingAnalysis()) and must stay
-- lowercase/underscore/unique — enforced by both a CHECK constraint here
-- and server-side validation on POST /api/coaching-stages.
--
-- Seeded with the CURRENT 11 hardcoded stages in their CURRENT order so
-- existing behavior is unchanged on deploy — this is a refactor, not a
-- reset. sort_order uses multiples of 10 (10, 20, 30, ...) so a future
-- reordering/insert-between pass has integer headroom without a full
-- renumber; this migration does not implement reordering itself (see this
-- task's report for that follow-up recommendation).
--
-- ⚠️⚠️⚠️ MANUAL STEP REQUIRED BEFORE THIS FEATURE WORKS IN PROD ⚠️⚠️⚠️
-- This repo's migrations are NOT run automatically on deploy (see
-- migrate.js's header + server.js's ensureSessionsTable() being the actual
-- de-facto migration runner for anything that must apply on every boot).
-- This file's CREATE/ALTER/seed statements are ALSO mirrored inside
-- ensureSessionsTable() in server.js (idempotent, ON CONFLICT DO NOTHING
-- on the seed) so a normal deploy-from-main brings a fresh or existing DB
-- into sync automatically — this migration file remains the readable,
-- reviewable record of the schema/seed decision, and can also be run by
-- hand via `node server/scripts/apply-coaching-stages-migration.mjs` (same
-- convention as apply-coaching-analysis-migration.mjs) against the live
-- Railway/Neon DATABASE_URL if you need to apply it ahead of a deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS coaching_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS coaching_stages_sort_order_idx
  ON coaching_stages (sort_order);

-- Seed: the current 11 hardcoded stages, in current order (10-110 so a
-- later insert-between pass has integer headroom). ON CONFLICT DO NOTHING
-- on the unique `key` makes this safe to re-run (idempotent), matching
-- this repo's ensureSessionsTable() convention for ongoing-boot-time
-- schema/seed application.
INSERT INTO coaching_stages (key, label, sort_order) VALUES
  ('setup_call', 'Setup Call', 10),
  ('arrival', 'Arrival', 20),
  ('upfront_4', 'Upfront 4', 30),
  ('first_go_around', '1st Go Around', 40),
  ('client_manual', 'Client Manual', 50),
  ('second_go_around', '2nd Go Around', 60),
  ('rough_estimate', 'Rough Estimate', 70),
  ('prepare_proposal', 'Prepare Proposal', 80),
  ('proposal_presentation', 'Proposal Presentation', 90),
  ('ask_for_order', 'Ask for the Order', 100),
  ('follow_up', 'Follow Up', 110)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verification query (reference for hand-testing):
--   SELECT key, label, sort_order FROM coaching_stages ORDER BY sort_order ASC;
--   -- expected: the 11 rows above, in this exact order
