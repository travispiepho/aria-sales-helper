import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerCustomerRoutes } from '../customers.js';

function poolFixture() {
  const customers = [];
  let sequence = 0;
  return {
    customers,
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO customers')) {
        const row = {
          id: `c-${++sequence}`,
          name: params[0],
          address: params[1],
          phone: params[2],
          email: params[3],
          source: params[4],
          created_by: params[5],
          created_at: new Date().toISOString(),
        };
        customers.push(row);
        return { rows: [row] };
      }
      if (sql === 'SELECT * FROM customers ORDER BY created_at DESC') {
        return { rows: [...customers].reverse() };
      }
      if (sql === 'SELECT * FROM customers WHERE created_by = $1 ORDER BY created_at DESC') {
        return { rows: customers.filter((c) => c.created_by === params[0]).reverse() };
      }
      if (sql === 'SELECT * FROM customers WHERE id = $1') {
        return { rows: customers.filter((c) => c.id === params[0]) };
      }
      if (sql.startsWith('UPDATE customers SET')) {
        const id = params[params.length - 1];
        const row = customers.find((c) => c.id === id);
        if (!row) return { rows: [] };
        // Reconstruct field order from the SET clause the route built —
        // simplest correct approach for this fixture: re-parse which
        // columns were included via the SQL text itself.
        const setClause = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
        const columns = setClause.split(',').map((part) => part.trim().split('=')[0].trim());
        columns.forEach((col, i) => { row[col] = params[i]; });
        return { rows: [row] };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

async function appFixture({ authenticated = true, user = { id: 'rep-1', role: 'rep' } } = {}) {
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('user', null);
  const pool = poolFixture();
  await registerCustomerRoutes(app, {
    pool,
    hasAdminAccess: (role) => role === 'admin',
    requireAuth: async (request, reply) => {
      if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' });
      request.user = user;
    },
  });
  await app.ready();
  return { app, pool };
}

test('POST /api/customers requires auth and a name', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal(
    (await denied.app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'Jane' } })).statusCode,
    401
  );
  await denied.app.close();

  const { app } = await appFixture();
  assert.equal((await app.inject({ method: 'POST', url: '/api/customers', payload: {} })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'Jane Smith', phone: '6165551212' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().name, 'Jane Smith');
  await app.close();
});

test('GET /api/customers scopes to created_by for non-admins, sees all for admins', async () => {
  const { app, pool } = await appFixture();
  await app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'Rep One Customer' } });
  pool.customers.push({ id: 'c-other', name: 'Someone Else', created_by: 'rep-2', created_at: new Date().toISOString() });

  const own = (await app.inject({ method: 'GET', url: '/api/customers' })).json();
  assert.deepEqual(own.map((c) => c.name), ['Rep One Customer']);
  await app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  admin.pool.customers.push(...pool.customers);
  const all = (await admin.app.inject({ method: 'GET', url: '/api/customers' })).json();
  assert.equal(all.length, 2);
  await admin.app.close();
});

test('GET /api/customers/:id enforces created_by ownership (403 for a non-owner, non-admin rep)', async () => {
  const { app, pool } = await appFixture();
  const created = (await app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'Jane' } })).json();
  assert.equal((await app.inject({ method: 'GET', url: `/api/customers/${created.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/customers/missing' })).statusCode, 404);
  await app.close();

  const other = await appFixture({ user: { id: 'rep-2', role: 'rep' } });
  other.pool.customers.push(...pool.customers);
  assert.equal((await other.app.inject({ method: 'GET', url: `/api/customers/${created.id}` })).statusCode, 403);
  await other.app.close();
});

test('PATCH /api/customers/:id requires auth, persists partial updates, and rejects an empty name', async () => {
  const denied = await appFixture({ authenticated: false });
  assert.equal(
    (await denied.app.inject({ method: 'PATCH', url: '/api/customers/c-1', payload: { name: 'X' } })).statusCode,
    401
  );
  await denied.app.close();

  const { app } = await appFixture();
  const created = (await app.inject({
    method: 'POST',
    url: '/api/customers',
    payload: { name: 'Jane Smith', address: '123 Main St', phone: '6165551212', email: 'jane@example.com' },
  })).json();

  // Partial update: only phone changes, name/address/email must be untouched.
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/customers/${created.id}`,
    payload: { phone: '6165559999' },
  });
  assert.equal(patched.statusCode, 200);
  const updated = patched.json();
  assert.equal(updated.phone, '6165559999');
  assert.equal(updated.name, 'Jane Smith');
  assert.equal(updated.address, '123 Main St');
  assert.equal(updated.email, 'jane@example.com');

  // Persists across a follow-up GET (not just the PATCH response echo).
  const reread = await app.inject({ method: 'GET', url: `/api/customers/${created.id}` });
  assert.equal(reread.json().phone, '6165559999');

  // Empty-name rejection.
  const emptyName = await app.inject({ method: 'PATCH', url: `/api/customers/${created.id}`, payload: { name: '   ' } });
  assert.equal(emptyName.statusCode, 400);

  // No-op body rejection.
  const noFields = await app.inject({ method: 'PATCH', url: `/api/customers/${created.id}`, payload: {} });
  assert.equal(noFields.statusCode, 400);

  // Unknown id.
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/customers/does-not-exist', payload: { name: 'X' } })).statusCode, 404);

  await app.close();
});

test('PATCH /api/customers/:id enforces created_by ownership (403 for a non-owner, non-admin rep; 200 for admin)', async () => {
  const { app, pool } = await appFixture();
  const created = (await app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'Jane' } })).json();
  await app.close();

  const other = await appFixture({ user: { id: 'rep-2', role: 'rep' } });
  other.pool.customers.push(...pool.customers);
  assert.equal(
    (await other.app.inject({ method: 'PATCH', url: `/api/customers/${created.id}`, payload: { name: 'Hijacked' } })).statusCode,
    403
  );
  await other.app.close();

  const admin = await appFixture({ user: { id: 'admin-1', role: 'admin' } });
  admin.pool.customers.push(...pool.customers);
  const asAdmin = await admin.app.inject({ method: 'PATCH', url: `/api/customers/${created.id}`, payload: { name: 'Admin Edited' } });
  assert.equal(asAdmin.statusCode, 200);
  assert.equal(asAdmin.json().name, 'Admin Edited');
  await admin.app.close();
});
