import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerScheduledMeetingRoutes } from '../scheduledMeetings.js';
import { normalizePhoneNumber } from '../telephony.js';

function poolFixture() {
  const meetings = [];
  let sequence = 0;
  return { meetings, async query(sql, params = []) {
    if (sql.startsWith('INSERT INTO meetings')) {
      const row = { id: `m-${++sequence}`, rep_id: params[0], status: 'active', channel: params[1], title: params[2], scheduled_for: params[3], scheduled_timezone: params[4], scheduled_customer_name: params[5], scheduled_customer_phone: params[6], scheduled_customer_address: params[7], scheduled_started_at: null };
      meetings.push(row); return { rows: [row] };
    }
    if (sql.includes('FROM meetings m LEFT JOIN users')) {
      const now = new Date(params[0]); const rep = params[1];
      return { rows: meetings.filter((m) => m.scheduled_for && !m.scheduled_started_at && m.status === 'active' && new Date(m.scheduled_for) > now && (!rep || m.rep_id === rep)).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for)) };
    }
    if (sql === 'SELECT * FROM meetings WHERE id = $1') return { rows: meetings.filter((m) => m.id === params[0]) };
    if (sql.includes('SET channel = $1')) {
      const m = meetings.find((x) => x.id === params[7] && x.status === 'active' && !x.scheduled_started_at);
      if (!m) return { rows: [] }; Object.assign(m, { channel: params[0], title: params[1], scheduled_for: params[2], scheduled_timezone: params[3], scheduled_customer_name: params[4], scheduled_customer_phone: params[5], scheduled_customer_address: params[6] }); return { rows: [m] };
    }
    if (sql.includes("SET status = 'cancelled'")) {
      const m = meetings.find((x) => x.id === params[0] && x.status === 'active' && !x.scheduled_started_at); if (!m) return { rows: [] }; m.status = 'cancelled'; return { rows: [m] };
    }
    if (sql.includes('SET scheduled_started_at = NOW()')) {
      const m = meetings.find((x) => x.id === params[1] && x.status === 'active' && !x.scheduled_started_at); if (!m) return { rows: [] }; m.scheduled_started_at = new Date('2026-08-28T21:05:00Z'); m.started_at = m.scheduled_started_at; m.owner_session_id = params[0]; return { rows: [m] };
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  }};
}

async function appFixture({ authenticated = true } = {}) {
  const app = Fastify(); await app.register(cookie); app.decorateRequest('user', null);
  const pool = poolFixture();
  await registerScheduledMeetingRoutes(app, {
    pool, normalizePhoneNumber, hasAdminAccess: (role) => role === 'admin', shapeMeetingForClient: (row) => row,
    now: () => new Date('2026-08-28T21:00:00Z'),
    requireAuth: async (request, reply) => { if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' }); request.user = { id: 'rep-1', role: 'rep' }; },
  });
  await app.ready(); return { app, pool };
}
const future = { scheduled_local: '2026-08-29T10:00', timezone: 'America/Detroit', channel: 'phone', title: 'Call Jane', customer_name: 'Jane', customer_phone: '6165551212' };
const visit = { ...future, channel: 'in_person', title: 'Visit Jane', customer_phone: '' };

test('create/list/edit/cancel are authenticated, ordered and filtered', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal((await denied.app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: future })).statusCode, 401); await denied.app.close();
  const { app, pool } = await appFixture();
  assert.equal((await app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: future })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: { ...future, scheduled_local: '2026-08-29T09:00', title: 'Earlier' } })).statusCode, 201);
  let listed = (await app.inject({ method: 'GET', url: '/api/scheduled-meetings' })).json().meetings;
  assert.deepEqual(listed.map((m) => m.title), ['Earlier', 'Call Jane']);
  const edited = await app.inject({ method: 'PATCH', url: `/api/scheduled-meetings/${pool.meetings[0].id}`, payload: { ...future, title: 'Updated' } });
  assert.equal(edited.json().title, 'Updated');
  assert.equal((await app.inject({ method: 'POST', url: `/api/scheduled-meetings/${pool.meetings[1].id}/cancel` })).statusCode, 200);
  listed = (await app.inject({ method: 'GET', url: '/api/scheduled-meetings' })).json().meetings;
  assert.deepEqual(listed.map((m) => m.title), ['Updated']); await app.close();
});

test('start transitions in place and is idempotent without creating a duplicate', async () => {
  const { app, pool } = await appFixture();
  const created = (await app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: visit })).json();
  const one = (await app.inject({ method: 'POST', url: `/api/scheduled-meetings/${created.id}/start`, headers: { cookie: 'session_id=owner' } })).json();
  const two = (await app.inject({ method: 'POST', url: `/api/scheduled-meetings/${created.id}/start`, headers: { cookie: 'session_id=owner' } })).json();
  assert.equal(one.id, created.id); assert.equal(two.id, created.id); assert.equal(pool.meetings.length, 1); assert.ok(one.scheduled_started_at); await app.close();
});

test('server rejects past schedules and invalid call details', async () => {
  const { app } = await appFixture();
  assert.equal((await app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: { ...future, scheduled_local: '2026-08-28T10:00' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scheduled-meetings', payload: { ...future, customer_phone: 'bad' } })).statusCode, 400); await app.close();
});
