-- 2026-08-05-meeting-interrupted-status.sql
--
-- PROPOSED / SKETCH ONLY — NOT APPLIED TO PRODUCTION. Written to support the
-- server.js fix (finalizeMeetingIfAbandoned / the WS `close` handler) that
-- auto-terminates a meeting when its audio WebSocket disconnects and no
-- client reconnects within a grace period — see server.js's
-- "Root-cause fix (2026-08-05): stuck-`active`-meeting bug" comment block
-- for the full write-up of why `'interrupted'` was chosen over reusing
-- `'completed'`.
--
-- Root cause being fixed: meetings whose client disconnected unexpectedly
-- (app backgrounded/killed, network drop, crash, server restart) never left
-- `status = 'active'`, because the only code path that ever changed status
-- was the explicit client-initiated `PATCH /api/meetings/:id` (the "End
-- Meeting" button, and now the mobile app's leave-app-guard). Diagnosed
-- 2026-08-04 — see memory/aria-web-runaway-meetings-2026-08-04.md.
--
-- This is a MINIMAL, additive change: it only widens the existing
-- `meetings_status_check` CHECK constraint to allow one new value. It does
-- NOT touch any existing row, rename any column, or change any default.
--
-- Repo convention note: same idempotent-migration style as the other
-- 2026-08-04 migration files in this directory (no migration framework
-- exists in this repo — plain SQL only, run manually via `psql`/`node` per
-- DEPLOY.md). This file has NOT been run against the production Neon DB.
-- Do not apply without Gabe/Troy sign-off on the 'interrupted' status name
-- (see server.js comment for alternatives considered).

BEGIN;

-- Postgres has no `ALTER CHECK CONSTRAINT ... ADD VALUE` — a CHECK
-- constraint (unlike a native ENUM type) must be dropped and recreated with
-- the widened value list. This is a metadata-only operation (no table
-- rewrite, no data touched) and is safe to run on a live table with rows
-- present, same as any other `DROP CONSTRAINT` / `ADD CONSTRAINT` pair.
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('active', 'completed', 'cancelled', 'interrupted'));

COMMIT;

-- ─── Why this is safe to apply later without much risk ────────────────────
-- Every existing row's `status` is already one of 'active' | 'completed' |
-- 'cancelled' (the current constraint), all of which remain valid under the
-- widened constraint — this migration can never fail against existing data.
-- The only behavior change is that server.js's `finalizeMeetingIfAbandoned`
-- (currently deployed defensively — its UPDATE is wrapped in try/catch and
-- logs-but-doesn't-throw on constraint violation) will start actually
-- succeeding instead of no-op-failing once this is applied. Until this
-- migration runs, the stuck-active-meeting bug's WORST case reverts to
-- today's pre-fix behavior (meeting stays 'active') rather than any new
-- failure mode — the fix is inert-safe without this migration, not
-- silently broken.
