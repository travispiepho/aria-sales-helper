import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerCoachingStageRoutes } from '../coachingStages.js';

function poolFixture(initialStages = []) {
  const stages = initialStages.map((s) => ({ ...s }));
  const snapshots = [];
  let sequence = stages.length;
  return {
    stages,
    snapshots,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT id, key, label, sort_order, created_at, updated_at\n       FROM coaching_stages\n       ORDER BY sort_order ASC')) {
        return { rows: [...stages].sort((a, b) => a.sort_order - b.sort_order) };
      }
      if (sql === 'SELECT id FROM coaching_stages WHERE key = $1') {
        return { rows: stages.filter((s) => s.key === params[0]).map((s) => ({ id: s.id })) };
      }
      if (sql === 'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM coaching_stages') {
        const max = stages.reduce((acc, s) => Math.max(acc, s.sort_order), 0);
        return { rows: [{ max_order: max }] };
      }
      if (sql.startsWith('INSERT INTO coaching_stages')) {
        const row = {
          id: `stage-${++sequence}`,
          key: params[0],
          label: params[1],
          sort_order: params[2],
          created_by: params[3],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        stages.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT COUNT(*)::int AS count FROM coaching_snapshots')) {
        const count = snapshots.filter((s) => s?.stage?.current === params[0]).length;
        return { rows: [{ count }] };
      }
      if (sql === 'DELETE FROM coaching_stages WHERE key = $1') {
        const idx = stages.findIndex((s) => s.key === params[0]);
        if (idx >= 0) stages.splice(idx, 1);
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

const SEED = [
  { id: 's-1', key: 'setup_call', label: 'Setup Call', sort_order: 10 },
  { id: 's-2', key: 'arrival', label: 'Arrival', sort_order: 20 },
  { id: 's-3', key: 'follow_up', label: 'Follow Up', sort_order: 110 },
];

async function appFixture({ authenticated = true, user = { id: 'rep-1', role: 'rep' }, seed = SEED } = {}) {
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('user', null);
  const pool = poolFixture(seed);
  await registerCoachingStageRoutes(app, {
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

test('GET /api/coaching-stages: 401 unauthenticated, 200 for any authenticated user (rep or admin), ordered by sort_order', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal((await denied.app.inject({ method: 'GET', url: '/api/coaching-stages' })).statusCode, 401);
  await denied.app.close();

  const rep = await appFixture({ user: { id: 'rep-1', role: 'rep' } });
  const repRes = await rep.app.inject({ method: 'GET', url: '/api/coaching-stages' });
  assert.equal(repRes.statusCode, 200);
  const repBody = repRes.json();
  assert.deepEqual(repBody.stages.map((s) => s.key), ['setup_call', 'arrival', 'follow_up']);
  await rep.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const adminRes = await admin.app.inject({ method: 'GET', url: '/api/coaching-stages' });
  assert.equal(adminRes.statusCode, 200);
  assert.equal(adminRes.json().stages.length, 3);
  await admin.app.close();
});

test('POST /api/coaching-stages: 401 unauthenticated, 403 non-admin, 201 admin, 201 owner', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal(
    (await denied.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'site_walkthrough', label: 'Site Walkthrough' } })).statusCode,
    401
  );
  await denied.app.close();

  const rep = await appFixture({ user: { id: 'rep-1', role: 'rep' } });
  assert.equal(
    (await rep.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'site_walkthrough', label: 'Site Walkthrough' } })).statusCode,
    403
  );
  await rep.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const adminRes = await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'site_walkthrough', label: 'Site Walkthrough' } });
  assert.equal(adminRes.statusCode, 201);
  const created = adminRes.json();
  assert.equal(created.key, 'site_walkthrough');
  assert.equal(created.label, 'Site Walkthrough');
  // Appended at the end (after existing max sort_order 110).
  assert.equal(created.sort_order, 120);
  await admin.app.close();

  const owner = await appFixture({ user: { id: 'owner-1', role: 'owner' } });
  const ownerRes = await owner.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'another_stage', label: 'Another Stage' } });
  assert.equal(ownerRes.statusCode, 201);
  await owner.app.close();
});

test('POST /api/coaching-stages validates key format, requires label, rejects duplicate key', async () => {
  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });

  assert.equal((await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: '', label: 'X' } })).statusCode, 400);
  assert.equal((await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'Has Spaces', label: 'X' } })).statusCode, 400);
  assert.equal((await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'UPPERCASE', label: 'X' } })).statusCode, 400);
  assert.equal((await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: '1_starts_with_digit', label: 'X' } })).statusCode, 400);
  assert.equal((await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'valid_key', label: '' } })).statusCode, 400);

  const dup = await admin.app.inject({ method: 'POST', url: '/api/coaching-stages', payload: { key: 'setup_call', label: 'Setup Call Dup' } });
  assert.equal(dup.statusCode, 409);

  await admin.app.close();
});

test('DELETE /api/coaching-stages/:key: 401 unauthenticated, 403 non-admin, 200 admin, 404 unknown key', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal((await denied.app.inject({ method: 'DELETE', url: '/api/coaching-stages/arrival' })).statusCode, 401);
  await denied.app.close();

  const rep = await appFixture({ user: { id: 'rep-1', role: 'rep' } });
  assert.equal((await rep.app.inject({ method: 'DELETE', url: '/api/coaching-stages/arrival' })).statusCode, 403);
  await rep.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  const okRes = await admin.app.inject({ method: 'DELETE', url: '/api/coaching-stages/arrival' });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().ok, true);

  const missing = await admin.app.inject({ method: 'DELETE', url: '/api/coaching-stages/not_a_real_key' });
  assert.equal(missing.statusCode, 404);
  await admin.app.close();
});

test('DELETE /api/coaching-stages/:key reports historical_usage_count without blocking the delete', async () => {
  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  admin.pool.snapshots.push({ stage: { current: 'arrival', label: 'Arrival' } });
  admin.pool.snapshots.push({ stage: { current: 'arrival', label: 'Arrival' } });
  admin.pool.snapshots.push({ stage: { current: 'setup_call', label: 'Setup Call' } });

  const res = await admin.app.inject({ method: 'DELETE', url: '/api/coaching-stages/arrival' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().historical_usage_count, 2);
  // Delete still succeeded despite historical usage (soft warning only).
  const afterList = (await admin.app.inject({ method: 'GET', url: '/api/coaching-stages' })).json();
  assert.equal(afterList.stages.some((s) => s.key === 'arrival'), false);

  await admin.app.close();
});
