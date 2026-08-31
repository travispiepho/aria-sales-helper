// coachingStages.js — Coaching Stages CRUD routes (2026-08-30,
// aria_coaching_stages_admin_tab), extracted into its own module (matching
// the customers.js / scheduledMeetings.js precedent) so the admin-gated
// POST/DELETE routes can be exercised with a real Fastify app + a
// lightweight pool fixture in server/test/coachingStages.test.mjs.
//
// Background: the sales-process "Stage" list CoachingPanel.tsx tracks a
// call's progress through (Setup Call → Follow Up, 11 stages) used to be a
// hardcoded STAGE_ORDER array in that component, with no admin UI and no
// backend persistence. This module is the new data-driven source of truth:
// coaching_stages rows (key, label, sort_order), seeded with the original
// 11 stages in their original order (see
// migrations/2026-08-30-coaching-stages.sql + server.js's
// ensureSessionsTable() mirror).
//
// Auth model — deliberately DIFFERENT from objections/rebuttals (see that
// route block's comment in server.js): stage list membership and ORDER are
// load-bearing for every rep's live coaching-progress percentage math
// (stageIndex / stages.length), so unlike the free-for-all objections
// library, only admins/owners may add or remove a stage. GET is open to
// any authenticated user (reps need to see what stages exist, same spirit
// as the read side of the Objections tab) — this mirrors the GET-open/
// POST+DELETE-admin-gated split already established by
// GET /api/admin/users (list) vs DELETE /api/admin/users/:id (admin-only)
// in server.js, just applied to a non-/admin/-prefixed route.
export async function registerCoachingStageRoutes(fastify, {
  pool,
  requireAuth,
  hasAdminAccess,
}) {
  const KEY_RE = /^[a-z][a-z0-9_]*$/;

  fastify.get('/api/coaching-stages', { preHandler: [requireAuth] }, async (request, reply) => {
    // Any authenticated user (rep or admin) may view the stage list — same
    // "reps should be able to see what stages exist" rationale as the
    // Objections tab's read side.
    const result = await pool.query(
      `SELECT id, key, label, sort_order, created_at, updated_at
       FROM coaching_stages
       ORDER BY sort_order ASC`
    );
    return { stages: result.rows };
  });

  fastify.post('/api/coaching-stages', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!hasAdminAccess(request.user.role)) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { key, label } = request.body || {};
    // Trim only — deliberately NOT auto-lowercased/sanitized. Silently
    // coercing "Site Walkthrough" into "site_walkthrough" would let an
    // admin believe they created one key when a different, transformed key
    // actually got stored. Reject non-conforming input instead and let the
    // admin retype it correctly (same "explicit validation error, not a
    // silent normalize" preference as customers.js's empty-name PATCH
    // rejection).
    const trimmedKey = String(key || '').trim();
    const trimmedLabel = String(label || '').trim();

    if (!trimmedKey) {
      return reply.code(400).send({ error: 'key is required' });
    }
    if (!KEY_RE.test(trimmedKey)) {
      return reply.code(400).send({
        error: 'key must be lowercase letters, numbers, and underscores only, starting with a letter (e.g. "site_walkthrough")',
      });
    }
    if (!trimmedLabel) {
      return reply.code(400).send({ error: 'label is required' });
    }

    const existing = await pool.query('SELECT id FROM coaching_stages WHERE key = $1', [trimmedKey]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: `A stage with key "${trimmedKey}" already exists` });
    }

    // New stages are appended to the END of the order (max existing
    // sort_order + 10, or 10 if the table is somehow empty) — see this
    // task's report for the "reordering is a follow-up, not in scope this
    // pass" note. Appending at the end is the only order-preserving,
    // non-destructive choice available without a reorder UI: it can never
    // silently shift where an in-flight meeting's already-detected stage
    // sits relative to the ones before it.
    const maxResult = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM coaching_stages');
    const nextOrder = maxResult.rows[0].max_order + 10;

    const result = await pool.query(
      `INSERT INTO coaching_stages (key, label, sort_order, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, key, label, sort_order, created_at, updated_at`,
      [trimmedKey, trimmedLabel, nextOrder, request.user.id]
    );

    return reply.code(201).send(result.rows[0]);
  });

  fastify.delete('/api/coaching-stages/:key', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!hasAdminAccess(request.user.role)) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { key } = request.params;

    const existing = await pool.query('SELECT id FROM coaching_stages WHERE key = $1', [key]);
    if (existing.rows.length === 0) {
      return reply.code(404).send({ error: 'Stage not found' });
    }

    // Soft warning (not a hard blocker, per the task's explicit judgment
    // call): check whether this stage's key still appears in any
    // historical meeting's coaching_snapshots.snapshot->stage->current, and
    // surface a count so the admin can make an informed call, without
    // preventing the delete outright. Deleting the row does NOT touch or
    // corrupt those historical snapshot rows (coaching_snapshots stores its
    // own JSONB copy of the stage label/key at the time it was detected,
    // independent of this table) — the only user-facing effect is that a
    // *future* stage lookup keyed on this now-gone `key` (if any screen
    // ever re-resolves a label from the live list instead of using the
    // snapshot's own stored label) would no longer find a match. Historical
    // meeting detail pages read the label straight from the stored
    // snapshot JSON, not by re-joining against coaching_stages, so no
    // stored history is actually broken by this delete.
    const usageResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM coaching_snapshots WHERE snapshot->'stage'->>'current' = $1`,
      [key]
    );
    const historicalUsageCount = usageResult.rows[0].count;

    await pool.query('DELETE FROM coaching_stages WHERE key = $1', [key]);

    return { ok: true, historical_usage_count: historicalUsageCount };
  });
}
