import { resolveScheduledTime, SCHEDULE_TIME_ZONE } from './scheduleTime.js';

const SCHEDULED_CHANNELS = new Set(['in_person', 'phone']);

function normalizedDetails(body, normalizePhoneNumber) {
  const title = String(body.title || '').trim();
  const customerName = String(body.customer_name || '').trim();
  const customerPhone = String(body.customer_phone || '').trim();
  const customerAddress = String(body.customer_address || '').trim();
  const channel = String(body.channel || '');
  if (!title) throw Object.assign(new Error('Meeting title is required.'), { statusCode: 400 });
  if (title.length > 160) throw Object.assign(new Error('Meeting title must be 160 characters or fewer.'), { statusCode: 400 });
  if (!customerName) throw Object.assign(new Error('Customer or meeting contact name is required.'), { statusCode: 400 });
  if (!SCHEDULED_CHANNELS.has(channel)) throw Object.assign(new Error('Meeting type must be phone or in-person.'), { statusCode: 400 });
  if (channel === 'phone' && !normalizePhoneNumber(customerPhone)) {
    throw Object.assign(new Error('A valid customer phone number is required for a scheduled call.'), { statusCode: 400 });
  }
  return { title, customerName, customerPhone: customerPhone || null, customerAddress: customerAddress || null, channel };
}

export async function registerScheduledMeetingRoutes(fastify, {
  pool, requireAuth, hasAdminAccess, shapeMeetingForClient, normalizePhoneNumber,
  now = () => new Date(),
}) {
  const canManage = (request, meeting) => hasAdminAccess(request.user.role) || meeting.rep_id === request.user.id;

  fastify.post('/api/scheduled-meetings', { preHandler: [requireAuth] }, async (request, reply) => {
    let details; let scheduledFor;
    try {
      details = normalizedDetails(request.body || {}, normalizePhoneNumber);
      scheduledFor = resolveScheduledTime(request.body?.scheduled_local, request.body?.timezone, now());
    } catch (error) { return reply.code(error.statusCode || 400).send({ error: error.message }); }
    const result = await pool.query(
      `INSERT INTO meetings (rep_id, status, channel, title, scheduled_for, scheduled_timezone,
         scheduled_customer_name, scheduled_customer_phone, scheduled_customer_address, origin_client, started_at)
       VALUES ($1, 'active', $2, $3, $4, $5, $6, $7, $8, 'web', $4) RETURNING *`,
      [request.user.id, details.channel, details.title, scheduledFor, SCHEDULE_TIME_ZONE,
        details.customerName, details.customerPhone, details.customerAddress]
    );
    return reply.code(201).send(shapeMeetingForClient(result.rows[0], request.cookies?.session_id || null));
  });

  fastify.get('/api/scheduled-meetings', { preHandler: [requireAuth] }, async (request) => {
    const params = [now()];
    const ownerFilter = hasAdminAccess(request.user.role) ? '' : `AND m.rep_id = $${params.push(request.user.id)}`;
    const result = await pool.query(
      `SELECT m.*, u.name AS rep_name FROM meetings m LEFT JOIN users u ON m.rep_id = u.id
       WHERE m.scheduled_for IS NOT NULL AND m.scheduled_started_at IS NULL
         AND m.status = 'active' AND m.scheduled_for > $1 ${ownerFilter}
       ORDER BY m.scheduled_for ASC, m.id ASC`, params);
    const sessionId = request.cookies?.session_id || null;
    return { meetings: result.rows.map((row) => shapeMeetingForClient(row, sessionId)) };
  });

  fastify.patch('/api/scheduled-meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const meeting = (await pool.query('SELECT * FROM meetings WHERE id = $1', [request.params.id])).rows[0];
    if (!meeting?.scheduled_for) return reply.code(404).send({ error: 'Scheduled meeting not found' });
    if (!canManage(request, meeting)) return reply.code(403).send({ error: 'Forbidden' });
    if (meeting.status !== 'active' || meeting.scheduled_started_at) return reply.code(409).send({ error: 'Only an upcoming meeting can be edited.' });
    let details; let scheduledFor;
    try {
      details = normalizedDetails(request.body || {}, normalizePhoneNumber);
      scheduledFor = resolveScheduledTime(request.body?.scheduled_local, request.body?.timezone, now());
    } catch (error) { return reply.code(error.statusCode || 400).send({ error: error.message }); }
    const result = await pool.query(
      `UPDATE meetings SET channel = $1, title = $2, scheduled_for = $3, scheduled_timezone = $4,
         scheduled_customer_name = $5, scheduled_customer_phone = $6, scheduled_customer_address = $7,
         started_at = $3, auto_titled = false
       WHERE id = $8 AND status = 'active' AND scheduled_started_at IS NULL RETURNING *`,
      [details.channel, details.title, scheduledFor, SCHEDULE_TIME_ZONE, details.customerName,
        details.customerPhone, details.customerAddress, meeting.id]);
    if (!result.rows[0]) return reply.code(409).send({ error: 'This meeting is no longer upcoming.' });
    return shapeMeetingForClient(result.rows[0], request.cookies?.session_id || null);
  });

  fastify.post('/api/scheduled-meetings/:id/cancel', { preHandler: [requireAuth] }, async (request, reply) => {
    const meeting = (await pool.query('SELECT * FROM meetings WHERE id = $1', [request.params.id])).rows[0];
    if (!meeting?.scheduled_for) return reply.code(404).send({ error: 'Scheduled meeting not found' });
    if (!canManage(request, meeting)) return reply.code(403).send({ error: 'Forbidden' });
    const result = await pool.query(
      `UPDATE meetings SET status = 'cancelled', ended_at = NOW()
       WHERE id = $1 AND status = 'active' AND scheduled_started_at IS NULL RETURNING *`, [meeting.id]);
    if (!result.rows[0]) return reply.code(409).send({ error: 'This meeting is no longer upcoming.' });
    return shapeMeetingForClient(result.rows[0], request.cookies?.session_id || null);
  });

  fastify.post('/api/scheduled-meetings/:id/start', { preHandler: [requireAuth] }, async (request, reply) => {
    const meeting = (await pool.query('SELECT * FROM meetings WHERE id = $1', [request.params.id])).rows[0];
    if (!meeting?.scheduled_for) return reply.code(404).send({ error: 'Scheduled meeting not found' });
    if (!canManage(request, meeting)) return reply.code(403).send({ error: 'Forbidden' });
    if (meeting.status !== 'active') return reply.code(409).send({ error: 'This scheduled meeting is no longer active.' });
    if (meeting.channel === 'phone') return reply.code(400).send({ error: 'Scheduled calls start from the phone call flow.' });
    const sessionId = request.cookies?.session_id || null;
    if (meeting.scheduled_started_at) return shapeMeetingForClient(meeting, sessionId);
    const result = await pool.query(
      `UPDATE meetings SET scheduled_started_at = NOW(), started_at = NOW(), owner_session_id = $1, origin_client = 'web'
       WHERE id = $2 AND status = 'active' AND scheduled_started_at IS NULL RETURNING *`, [sessionId, meeting.id]);
    if (result.rows[0]) return shapeMeetingForClient(result.rows[0], sessionId);
    const raced = await pool.query('SELECT * FROM meetings WHERE id = $1', [meeting.id]);
    return shapeMeetingForClient(raced.rows[0], sessionId);
  });
}
