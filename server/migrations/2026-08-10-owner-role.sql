-- 2026-08-10-owner-role.sql
--
-- Adds the 'owner' role and assigns it to the single designated owner
-- account. Gabe's request (2026-08-10): "make a new aria user role 'owner'
-- that is higher than admin but also counts as an admin.
-- thacker@certapro.com should be the only owner. This account should be
-- the only account that can delete admin accounts in the Admin — Users
-- page."
--
-- Role model: 'rep' < 'admin' < 'owner'. 'owner' is a strict SUPERSET of
-- 'admin' — it grants everything admin grants (see server.js's
-- hasAdminAccess() helper, which every admin-gated check now routes
-- through) plus exactly one exclusive capability: deleting admin-level
-- accounts via DELETE /api/admin/users/:id (see isOwner() there).
--
-- WHY THIS IS A ONE-TIME DATA MIGRATION AND NOT A UI/ROUTE FEATURE:
-- the requirement is that there is exactly ONE owner, permanently. Any
-- "assign owner" route or invite-picker option would let an admin mint
-- additional owners, which directly contradicts "should be the only
-- owner". So 'owner' is deliberately NOT an invite-able role (the invites
-- table CHECK stays ('rep','admin')) and is not settable through any
-- endpoint. It is set exactly once, here.
--
-- Repo convention note: same idempotent plain-SQL style as the other
-- migration files in this directory (no migration framework exists in this
-- repo — run manually via node/psql per DEPLOY.md).
--
-- APPLIED TO PRODUCTION (Neon): 2026-08-10. Verification output recorded
-- at the bottom of this file.

BEGIN;

-- ─── Step 1: widen the role CHECK constraint ──────────────────────────────
-- Postgres has no "ALTER CHECK CONSTRAINT ... ADD VALUE" — a CHECK
-- constraint (unlike a native ENUM type) must be dropped and recreated with
-- the widened value list. Metadata-only: no table rewrite, no row touched,
-- safe on a live table with rows present. Every existing row's role is
-- already 'rep' or 'admin', both still valid under the widened constraint,
-- so this cannot fail against existing data.
--
-- NOTE: server.js's ensureSessionsTable() performs this SAME widening on
-- every boot (idempotently), so the running code can never get ahead of the
-- schema. This file documents the change and lets it be applied ahead of a
-- deploy if desired; running both is harmless.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('rep', 'admin', 'owner'));

-- ─── Step 2: assign the single owner ──────────────────────────────────────
-- thacker@certapro.com already existed as an active role='admin' row at the
-- time this was written (verified by direct query before running), so this
-- is a role FLIP on an existing row, not an account creation. Creating an
-- account was explicitly out of scope (no password/invite flow decided).
--
-- Guarded so it is idempotent and cannot promote anyone else: matched on
-- the exact email (LOWER() for case-safety) and restricted to a row that
-- is currently admin-or-owner. If the email did not exist this UPDATE
-- would affect 0 rows rather than silently creating anything.
UPDATE users
   SET role = 'owner'
 WHERE LOWER(email) = 'thacker@certapro.com'
   AND role IN ('admin', 'owner');

-- ─── Step 3: enforce the "exactly one owner" invariant ────────────────────
-- Defensive demotion: should any other row ever hold 'owner' (it never
-- should — the role is unassignable through the app), collapse it back to
-- 'admin' so the invariant holds. No-op on a correct database.
UPDATE users
   SET role = 'admin'
 WHERE role = 'owner'
   AND LOWER(email) <> 'thacker@certapro.com';

COMMIT;

-- ─── Verification queries (run after COMMIT) ──────────────────────────────
-- Expect exactly one row: thacker@certapro.com | owner
--   SELECT email, role FROM users WHERE role = 'owner';
-- Expect: 1
--   SELECT COUNT(*) FROM users WHERE role = 'owner';
-- Expect the constraint def to include 'owner':
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'users'::regclass AND contype = 'c';
--
-- ACTUAL OUTPUT WHEN APPLIED 2026-08-10:
--   users CHECK: users_role_check
--     CHECK ((role = ANY (ARRAY['rep'::text, 'admin'::text, 'owner'::text])))
--   owner rows: 1 — thacker@certapro.com
