import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerCoachingPromptRoutes, getPromptText, invalidatePromptCache } from '../coachingPrompts.js';

function poolFixture(initialPrompts = []) {
  const prompts = initialPrompts.map((p) => ({ ...p }));
  let queryCount = 0;
  return {
    prompts,
    get queryCount() { return queryCount; },
    async query(sql, params = []) {
      queryCount++;
      if (sql.startsWith('SELECT key, label, prompt_text, updated_at, updated_by\n       FROM coaching_prompts')) {
        return { rows: [...prompts].sort((a, b) => a.key.localeCompare(b.key)) };
      }
      if (sql === 'SELECT prompt_text FROM coaching_prompts WHERE key = $1') {
        const match = prompts.filter((p) => p.key === params[0]);
        return { rows: match.map((p) => ({ prompt_text: p.prompt_text })) };
      }
      if (sql === 'SELECT id FROM coaching_prompts WHERE key = $1') {
        return { rows: prompts.filter((p) => p.key === params[0]).map((p) => ({ id: p.id })) };
      }
      if (sql.startsWith('UPDATE coaching_prompts')) {
        const row = prompts.find((p) => p.key === params[2]);
        if (!row) return { rows: [] };
        row.prompt_text = params[0];
        row.updated_by = params[1];
        row.updated_at = new Date().toISOString();
        return { rows: [{ key: row.key, label: row.label, prompt_text: row.prompt_text, updated_at: row.updated_at, updated_by: row.updated_by }] };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

const SEED = [
  { id: 'p-1', key: 'bant', label: 'BANT + Closing Certainty Analysis', prompt_text: 'You are ARIA, a sales coaching analyst...' },
  { id: 'p-2', key: 'coaching_realtime', label: 'Real-Time Coaching (In-Person)', prompt_text: 'You are ARIA, a real-time sales coaching assistant...' },
  { id: 'p-3', key: 'rebuttal', label: 'Live Rebuttal Suggestion', prompt_text: 'You are ARIA, giving a CertaPro Painters field rep a real-time rebuttal suggestion...' },
];

async function appFixture({ authenticated = true, user = { id: 'rep-1', role: 'rep' }, seed = SEED } = {}) {
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('user', null);
  const pool = poolFixture(seed);
  await registerCoachingPromptRoutes(app, {
    pool,
    hasAdminAccess: (role) => role === 'admin' || role === 'owner',
    requireAuth: async (request, reply) => {
      if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' });
      request.user = user;
    },
  });
  await app.ready();
  return { app, pool };
}

// ─── GET /api/coaching-prompts: read-open auth matrix ──────────────────────

test('GET /api/coaching-prompts: 401 unauthenticated, 200 for any authenticated user (rep or admin), returns all seeded prompts', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal((await denied.app.inject({ method: 'GET', url: '/api/coaching-prompts' })).statusCode, 401);
  await denied.app.close();

  const rep = await appFixture({ user: { id: 'rep-1', role: 'rep' } });
  const repRes = await rep.app.inject({ method: 'GET', url: '/api/coaching-prompts' });
  assert.equal(repRes.statusCode, 200);
  const repBody = repRes.json();
  assert.equal(repBody.prompts.length, 3);
  assert.deepEqual(repBody.prompts.map((p) => p.key).sort(), ['bant', 'coaching_realtime', 'rebuttal']);
  await rep.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const adminRes = await admin.app.inject({ method: 'GET', url: '/api/coaching-prompts' });
  assert.equal(adminRes.statusCode, 200);
  assert.equal(adminRes.json().prompts.length, 3);
  await admin.app.close();
});

// ─── PUT /api/coaching-prompts/:key: write-admin-gated auth matrix ─────────

test('PUT /api/coaching-prompts/:key: 401 unauthenticated, 403 non-admin, 200 admin, 200 owner', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal(
    (await denied.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: 'A new prompt that is long enough.' } })).statusCode,
    401
  );
  await denied.app.close();

  const rep = await appFixture({ user: { id: 'rep-1', role: 'rep' } });
  assert.equal(
    (await rep.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: 'A new prompt that is long enough.' } })).statusCode,
    403
  );
  await rep.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const adminRes = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: 'A brand new BANT prompt text for testing.' } });
  assert.equal(adminRes.statusCode, 200);
  const updated = adminRes.json();
  assert.equal(updated.key, 'bant');
  assert.equal(updated.prompt_text, 'A brand new BANT prompt text for testing.');
  assert.equal(updated.updated_by, 'admin-1');
  await admin.app.close();

  const owner = await appFixture({ user: { id: 'owner-1', role: 'owner' } });
  const ownerRes = await owner.app.inject({ method: 'PUT', url: '/api/coaching-prompts/rebuttal', payload: { prompt_text: 'A brand new rebuttal prompt for testing purposes.' } });
  assert.equal(ownerRes.statusCode, 200);
  await owner.app.close();
});

test('PUT /api/coaching-prompts/:key: 404 for unknown key', async () => {
  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const res = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/does_not_exist', payload: { prompt_text: 'A long enough replacement prompt text.' } });
  assert.equal(res.statusCode, 404);
  await admin.app.close();
});

// ─── Validation: empty/too-short prompt rejected ───────────────────────────

test('PUT /api/coaching-prompts/:key: rejects empty and near-empty prompt_text', async () => {
  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });

  const empty = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: '' } });
  assert.equal(empty.statusCode, 400);

  const whitespace = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: '    ' } });
  assert.equal(whitespace.statusCode, 400);

  const tooShort = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: { prompt_text: 'short' } });
  assert.equal(tooShort.statusCode, 400);

  const missing = await admin.app.inject({ method: 'PUT', url: '/api/coaching-prompts/bant', payload: {} });
  assert.equal(missing.statusCode, 400);

  // Original text must remain unchanged after all rejected attempts.
  const row = admin.pool.prompts.find((p) => p.key === 'bant');
  assert.equal(row.prompt_text, 'You are ARIA, a sales coaching analyst...');

  await admin.app.close();
});

// ─── getPromptText(): cache + fallback behavior ────────────────────────────

test('getPromptText: returns DB value when a row exists, caches it (no repeat query within TTL)', async () => {
  const { pool } = await appFixture();
  const first = await getPromptText(pool, 'bant', 'FALLBACK TEXT');
  assert.equal(first, 'You are ARIA, a sales coaching analyst...');
  const countAfterFirst = pool.queryCount;

  const second = await getPromptText(pool, 'bant', 'FALLBACK TEXT');
  assert.equal(second, 'You are ARIA, a sales coaching analyst...');
  assert.equal(pool.queryCount, countAfterFirst, 'second call within TTL must be served from cache, no extra DB query');
});

test('getPromptText: falls back to the provided default when the DB row is missing', async () => {
  const { pool } = await appFixture({ seed: [] });
  const result = await getPromptText(pool, 'nonexistent_key', 'HARDCODED FALLBACK');
  assert.equal(result, 'HARDCODED FALLBACK');
});

test('getPromptText: falls back to the provided default when the DB query throws', async () => {
  const pool = { query: async () => { throw new Error('connection reset'); } };
  const result = await getPromptText(pool, 'bant', 'HARDCODED FALLBACK');
  assert.equal(result, 'HARDCODED FALLBACK');
});

test('invalidatePromptCache: forces the next getPromptText call to re-hit the DB', async () => {
  const { pool } = await appFixture();
  await getPromptText(pool, 'bant', 'FALLBACK'); // populates cache
  const countAfterFirst = pool.queryCount;

  invalidatePromptCache(pool, 'bant');

  // Mutate the underlying "DB" row directly (simulating an admin's write
  // via a different code path/process) and confirm the next read reflects
  // it instead of serving the stale cached value.
  pool.prompts.find((p) => p.key === 'bant').prompt_text = 'UPDATED TEXT AFTER INVALIDATION';
  const afterInvalidate = await getPromptText(pool, 'bant', 'FALLBACK');
  assert.equal(afterInvalidate, 'UPDATED TEXT AFTER INVALIDATION');
  assert.ok(pool.queryCount > countAfterFirst, 'must have re-queried the DB after invalidation');
});

test('PUT then getPromptText: an admin edit is immediately visible to the next prompt read (cache invalidated on write)', async () => {
  const { app, pool } = await appFixture({ user: { id: 'admin-1', role: 'admin' } });

  // Warm the cache with the original value first.
  const before = await getPromptText(pool, 'bant', 'FALLBACK');
  assert.equal(before, 'You are ARIA, a sales coaching analyst...');

  const putRes = await app.inject({
    method: 'PUT',
    url: '/api/coaching-prompts/bant',
    payload: { prompt_text: 'Freshly edited BANT prompt text from an admin.' },
  });
  assert.equal(putRes.statusCode, 200);

  const after = await getPromptText(pool, 'bant', 'FALLBACK');
  assert.equal(after, 'Freshly edited BANT prompt text from an admin.', 'must reflect the PUT immediately, not a stale cached value');

  await app.close();
});
