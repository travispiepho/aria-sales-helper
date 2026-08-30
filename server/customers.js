// customers.js — Customer CRUD routes, extracted (2026-08-29,
// aria_customer_info_editable_section) from server.js's inline "Customer
// routes" block so the new PATCH /api/customers/:id route (and its
// siblings) can be exercised with a real Fastify app + a lightweight pool
// fixture in server/test/customers.test.mjs, matching the existing pattern
// already established by scheduledMeetings.js. Behavior of the
// pre-existing POST/GET/GET:id routes below is byte-for-byte unchanged
// from server.js's own inline versions — only PATCH /api/customers/:id is
// new.
export async function registerCustomerRoutes(fastify, {
  pool,
  requireAuth,
  hasAdminAccess,
}) {
  fastify.post('/api/customers', { preHandler: [requireAuth] }, async (request, reply) => {
    const { name, address, phone, email, source } = request.body || {};

    if (!name) {
      return reply.code(400).send({ error: 'name is required' });
    }

    const result = await pool.query(
      `INSERT INTO customers (name, address, phone, email, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, address || null, phone || null, email || null, source || null, request.user.id]
    );

    return reply.code(201).send(result.rows[0]);
  });

  fastify.get('/api/customers', { preHandler: [requireAuth] }, async (request, reply) => {
    const { role, id } = request.user;
    let result;

    if (hasAdminAccess(role)) {
      result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    } else {
      result = await pool.query(
        'SELECT * FROM customers WHERE created_by = $1 ORDER BY created_at DESC',
        [id]
      );
    }

    return result.rows;
  });

  fastify.get('/api/customers/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params;
    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const customer = result.rows[0];
    if (!hasAdminAccess(request.user.role) && customer.created_by !== request.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return customer;
  });

  // 2026-08-29 (aria_customer_info_editable_section): edit-an-existing-
  // customer-record, added so the new in-meeting "Customer Info" section
  // (see web/src/components/CustomerInfoSection.tsx) can persist rep edits
  // made during a live meeting rather than only ever creating a customer up
  // front via CustomerIntakeModal.tsx. Mirrors the update-a-record shape
  // already used by PATCH /api/meetings/:id and PATCH /api/profile in
  // server.js (verify-exists -> ownership-check -> build a partial UPDATE
  // from only the fields present in the body -> RETURNING *), and the
  // ownership check itself mirrors GET /api/customers/:id and GET
  // /api/customers immediately above: non-admins may only edit a customer
  // row they created (`created_by === request.user.id`), never an
  // arbitrary customer_id. There is no evidence in this data model that
  // this route should be treated as shared/team-wide the way objections/
  // rebuttals intentionally are (see that route block's comment in
  // server.js) — customers are a per-rep lead list (GET /api/customers is
  // already created_by-scoped for non-admins), so the same scoping is the
  // correct default here.
  fastify.patch('/api/customers/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params;
    const { name, address, phone, email, source } = request.body || {};

    const existing = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    const customer = existing.rows[0];
    if (!hasAdminAccess(request.user.role) && customer.created_by !== request.user.id) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // `name` is NOT NULL in the schema (see migrate.js's customers table) —
    // unlike POST's silent 'Unknown' fallback (a create-time default for a
    // field the rep may not have typed yet), an explicit PATCH clearing it
    // to empty is a genuine validation error, not something to paper over.
    if (name !== undefined && !String(name).trim()) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(String(name).trim()); }
    if (address !== undefined) { updates.push(`address = $${idx++}`); values.push(address ? String(address).trim() : null); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone ? String(phone).trim() : null); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); values.push(email ? String(email).trim() : null); }
    if (source !== undefined) { updates.push(`source = $${idx++}`); values.push(source ? String(source).trim() : null); }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    return result.rows[0];
  });
}
