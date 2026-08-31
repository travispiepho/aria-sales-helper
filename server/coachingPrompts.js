// coachingPrompts.js — DB-backed, admin-editable LLM coaching prompts
// (2026-08-30, aria_coaching_settings_prompt_editor_backend), extracted
// into its own module (matching the customers.js / scheduledMeetings.js /
// coachingStages.js precedent) so the admin-gated PUT route can be
// exercised with a real Fastify app + a lightweight pool fixture in
// server/test/coachingPrompts.test.mjs.
//
// Background: every LLM system prompt driving ARIA's coaching engine
// (real-time in-person coaching, real-time setup-call coaching, BANT,
// insider-language flagger, question-gap detector, live rebuttal
// suggestion) used to be a hardcoded template-literal constant in
// server.js / coachingAnalysis.js, with no admin UI and no way to tune a
// prompt's wording without a code deploy. This module is the new
// data-driven source of truth: coaching_prompts rows (key, label,
// prompt_text), seeded with the original 6 prompts' EXACT original text
// (see migrations/2026-08-30-coaching-prompts.sql + server.js's
// ensureSessionsTable() mirror) — this is a foundation for "maybe other
// features in the future" per Gabe's ask, so the schema/route design is
// intentionally generic (key + label + prompt_text + updated_at/
// updated_by) rather than hardcoded to today's 6 known keys.
//
// Auth model — mirrors coaching_stages.js EXACTLY (see that module's own
// comment block for the full rationale): GET is open to any authenticated
// user (reps/admins should all be able to see what prompt is currently
// live, same "read-open" spirit as the Objections tab and Coaching Stages
// tab), PUT is admin-only (hasAdminAccess()) since prompt wording directly
// controls what every rep's live coaching output looks like — the same
// "load-bearing for everyone, so only admins/owners may change it" logic
// coaching_stages.js applies to stage membership/order.
//
// UNLIKE coaching_stages, this pass only ships GET (list) + PUT
// (update-by-key) — no POST/DELETE. Prompt KEYS are a fixed, known set for
// now (seeded by the migration); a future "admin can add a brand new
// named prompt" feature would add POST/DELETE later without needing a
// schema change, since the table is already generic enough to support it.
//
// CACHING: coaching runs on every transcript tick during a live call (a
// handful of seconds apart), and each tick needs the current prompt text.
// Hitting Postgres on every single tick is wasteful, so this module keeps
// a simple per-pool in-memory cache with a short TTL AND explicit
// invalidate-on-write (the PUT route calls invalidatePromptCache() right
// after a successful UPDATE, so an admin's edit takes effect on the very
// next coaching tick rather than waiting out the TTL — the TTL alone is
// just a safety net for out-of-band DB writes, e.g. someone editing the
// row by hand in a DB console outside this API).
//
// The cache is keyed by pool INSTANCE (WeakMap<pool, Map<key, entry>>)
// rather than a single module-level Map — this means production (one
// long-lived pool) gets exactly the per-process cache behavior described
// above, while each test file's fresh pool fixture object automatically
// gets its own isolated cache with zero cross-test pollution risk, with no
// extra "reset the cache between tests" plumbing needed anywhere.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — safety net only; writes invalidate immediately.

const cachesByPool = new WeakMap();

function getCacheFor(pool) {
  let cache = cachesByPool.get(pool);
  if (!cache) {
    cache = new Map();
    cachesByPool.set(pool, cache);
  }
  return cache;
}

/**
 * getPromptText(pool, key, fallbackText)
 *
 * Returns the current prompt_text for `key`, sourced from the DB with a
 * short-TTL in-memory cache. Falls back to `fallbackText` (the caller's
 * hardcoded default) if:
 *   - the DB row for `key` doesn't exist (e.g. this migration hasn't run
 *     yet in some environment), or
 *   - the DB query throws (transient connection error, table doesn't
 *     exist yet, etc.)
 * This fallback is what keeps the coaching engine alive even before this
 * migration is applied everywhere, matching this repo's broader
 * "never let a coaching feature hard-fail the meeting" convention (see
 * coachingAnalysis.js's null-on-failure functions) — a DB hiccup degrades
 * to "use the last-known-good hardcoded prompt", never to a crash.
 */
export async function getPromptText(pool, key, fallbackText) {
  const cache = getCacheFor(pool);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && (now - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.text;
  }

  try {
    const result = await pool.query('SELECT prompt_text FROM coaching_prompts WHERE key = $1', [key]);
    if (result.rows.length === 0) {
      return fallbackText;
    }
    const text = result.rows[0].prompt_text;
    cache.set(key, { text, cachedAt: now });
    return text;
  } catch (err) {
    console.error(`coachingPrompts.getPromptText DB error for key "${key}":`, err.message);
    // Serve stale cache if we have it (better than reverting to the
    // hardcoded default mid-outage if an admin has customized this
    // prompt), otherwise fall back to the hardcoded default.
    return cached ? cached.text : fallbackText;
  }
}

/** Drop a key's cached entry so the next getPromptText() call re-fetches from the DB. */
export function invalidatePromptCache(pool, key) {
  const cache = cachesByPool.get(pool);
  if (cache) cache.delete(key);
}

export async function registerCoachingPromptRoutes(fastify, {
  pool,
  requireAuth,
  hasAdminAccess,
}) {
  // Minimal sanity floor — an admin fat-fingering a near-empty string
  // (e.g. accidentally clearing the textarea and saving) would otherwise
  // silently ship a useless/broken system prompt to the coaching LLM on
  // the very next transcript tick. This is deliberately generous (not a
  // "must look like a real prompt" heuristic) — just enough to catch the
  // empty/near-empty case per the task's explicit requirement.
  const MIN_PROMPT_LENGTH = 20;

  fastify.get('/api/coaching-prompts', { preHandler: [requireAuth] }, async (request, reply) => {
    // Any authenticated user (rep or admin) may view current prompt text —
    // same "reps should be able to see what's currently live" rationale as
    // GET /api/coaching-stages.
    const result = await pool.query(
      `SELECT key, label, prompt_text, updated_at, updated_by
       FROM coaching_prompts
       ORDER BY key ASC`
    );
    return { prompts: result.rows };
  });

  fastify.put('/api/coaching-prompts/:key', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!hasAdminAccess(request.user.role)) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { key } = request.params;
    const { prompt_text: promptText } = request.body || {};
    const trimmed = typeof promptText === 'string' ? promptText.trim() : '';

    if (!trimmed) {
      return reply.code(400).send({ error: 'prompt_text is required' });
    }
    if (trimmed.length < MIN_PROMPT_LENGTH) {
      return reply.code(400).send({
        error: `prompt_text must be at least ${MIN_PROMPT_LENGTH} characters (this would break the coaching engine)`,
      });
    }

    const existing = await pool.query('SELECT id FROM coaching_prompts WHERE key = $1', [key]);
    if (existing.rows.length === 0) {
      return reply.code(404).send({ error: `Prompt "${key}" not found` });
    }

    const result = await pool.query(
      `UPDATE coaching_prompts
       SET prompt_text = $1, updated_by = $2, updated_at = NOW()
       WHERE key = $3
       RETURNING key, label, prompt_text, updated_at, updated_by`,
      [trimmed, request.user.id, key]
    );

    // Invalidate BEFORE returning, not fire-and-forget after — the next
    // coaching tick (which could fire within seconds on a live call) must
    // never race this response and read a stale cached prompt.
    invalidatePromptCache(pool, key);

    return result.rows[0];
  });
}
