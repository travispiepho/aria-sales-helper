// Shared role helpers — 2026-08-10.
//
// Role model (Gabe's request): 'rep' < 'admin' < 'owner'.
//
// 'owner' is a strict SUPERSET of 'admin': it grants everything admin
// grants, plus exactly one extra capability (removing admin-level accounts
// on the Admin — Users page). It is NOT a parallel/separate role, so every
// pre-existing `user?.role === 'admin'` UI gate must also accept 'owner' —
// otherwise the owner account would paradoxically see LESS than a plain
// admin (no Admin link in Settings, a 403 card on /admin/users, etc.).
//
// These helpers exist so that rule lives in ONE place instead of being
// re-derived at each call site, mirroring server.js's hasAdminAccess() /
// isOwner() helpers. Keep the two in sync.
//
// There is exactly ONE owner (thacker@certapro.com), assigned by a one-time
// data migration (server/migrations/2026-08-10-owner-role.sql). The role is
// deliberately NOT assignable through any route or UI — notably it is not
// an option in the invite role picker, since an invite-able owner role
// would let any admin mint additional owners.

export type Role = 'rep' | 'admin' | 'owner';

/**
 * True for any role at admin level or above ('admin' or 'owner').
 * Use this for ALL admin-gated UI — it is the default check.
 */
export function hasAdminAccess(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'owner';
}

/**
 * True only for the single owner account.
 * Use ONLY for the owner-exclusive capability (removing admin accounts).
 * The server is the actual security boundary (DELETE /api/admin/users/:id
 * returns 403); this only drives the UI affordance.
 */
export function isOwner(role: string | undefined | null): boolean {
  return role === 'owner';
}

/** Human-readable label for a role badge. */
export function roleLabel(role: string | undefined | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Sales Rep';
}
