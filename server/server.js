/**
 * server.js — SorterPro Sales Helper API
 * Phase 1: Auth, meetings, customers
 * Phase 2: WebSocket audio → Deepgram live transcription, consent, summary
 * Phase 3: Real-time coaching engine (DISC, stage, checklist, nudges)
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import pg from 'pg';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import WebSocket from 'ws';

const { Pool } = pg;

// ─── Config ───────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Support both OPENROUTER_API_KEY (canonical) and OPENROUTER_KEY (legacy .env.secrets)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const PORT = parseInt(process.env.PORT || '3000', 10);

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.warn('WARN: DEEPGRAM_API_KEY not set — WebSocket audio endpoint will reject connections.');
}

if (!OPENROUTER_API_KEY) {
  console.warn('WARN: OPENROUTER_API_KEY (or OPENROUTER_KEY) not set — coaching endpoint will be unavailable.');
}

// ─── Knowledge base (loaded at startup) ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

let kbDiscFramework = '';
let kbFirstGoAround = '';
let kb10Plus1Process = '';

async function loadKnowledgeBase() {
  const kbDir = join(__dirname, 'knowledge');
  try {
    kbDiscFramework = await readFile(join(kbDir, 'disc-framework.md'), 'utf-8');
    console.log('✓ Loaded disc-framework.md');
  } catch (e) {
    console.warn('WARN: Could not load disc-framework.md:', e.message);
  }
  try {
    kbFirstGoAround = await readFile(join(kbDir, 'certapro-1st-go-around.md'), 'utf-8');
    console.log('✓ Loaded certapro-1st-go-around.md');
  } catch (e) {
    console.warn('WARN: Could not load certapro-1st-go-around.md:', e.message);
  }
  try {
    kb10Plus1Process = await readFile(join(kbDir, 'certapro-10plus1-sales-process.md'), 'utf-8');
    console.log('✓ Loaded certapro-10plus1-sales-process.md');
  } catch (e) {
    console.warn('WARN: Could not load certapro-10plus1-sales-process.md:', e.message);
  }
}

// ─── Active WebSocket connections (meetingId → Set<WebSocket>) ───────────────
// Used to push coaching updates to clients without polling

const activeMeetingSockets = new Map();

function registerMeetingSocket(meetingId, socket) {
  if (!activeMeetingSockets.has(meetingId)) {
    activeMeetingSockets.set(meetingId, new Set());
  }
  activeMeetingSockets.get(meetingId).add(socket);
}

function unregisterMeetingSocket(meetingId, socket) {
  const sockets = activeMeetingSockets.get(meetingId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) activeMeetingSockets.delete(meetingId);
  }
}

function broadcastToMeeting(meetingId, payload) {
  const sockets = activeMeetingSockets.get(meetingId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

// Anthropic client (optional — summary will stub if key missing)
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : OPENROUTER_API_KEY
    ? new Anthropic({
        apiKey: OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: { 'HTTP-Referer': 'https://aria.certaprograndhaven.com', 'X-Title': 'ARIA Sales Helper' }
      })
    : null;

// ─── DB Pool ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Postgres-backed session store (survives restarts) ──────────────────────

async function ensureSessionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  // Phase 3: coaching snapshots table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coaching_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id UUID NOT NULL REFERENCES meetings(id),
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function createSession(userId) {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, userId, expiresAt]
  );
  return sessionId;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  const result = await pool.query(
    'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  return { userId: result.rows[0].user_id };
}

async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

// ─── Fastify setup ────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: { level: 'info' },
});

await fastify.register(cookie, {
  secret: SESSION_SECRET,
  hook: 'onRequest',
});

await fastify.register(cors, {
  origin: (origin, cb) => {
    const allowed = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
});

await fastify.register(websocketPlugin);

// ─── Auth middleware (decorator) ──────────────────────────────────────────────

fastify.decorateRequest('user', null);

fastify.addHook('preHandler', async (request, reply) => {
  // Attach user to request if session cookie present
  const sessionId = request.cookies?.session_id;
  const session = await getSession(sessionId);
  if (session) {
    const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [session.userId]);
    if (result.rows.length > 0) {
      request.user = result.rows[0];
    }
  }
});

async function requireAuth(request, reply) {
  if (!request.user) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

fastify.get('/health', async (request, reply) => {
  try {
    await pool.query('SELECT 1');
    return {
      status: 'ok',
      db: 'connected',
      ts: new Date().toISOString(),
      deepgram: DEEPGRAM_API_KEY ? 'configured' : 'missing',
      anthropic: ANTHROPIC_API_KEY ? 'configured' : 'missing (summary will stub)',
    };
  } catch (err) {
    reply.code(503).send({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

fastify.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body || {};

  if (!email || !password) {
    return reply.code(400).send({ error: 'email and password are required' });
  }

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const sessionId = await createSession(user.id);

  reply
    .setCookie('session_id', sessionId, {
      httpOnly: true,
      path: '/',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400, // 24h
    })
    .send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
});

fastify.post('/api/auth/logout', async (request, reply) => {
  const sessionId = request.cookies?.session_id;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  reply
    .clearCookie('session_id', { path: '/' })
    .send({ ok: true });
});

fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
  return { user: request.user };
});

// ─── Meeting routes ───────────────────────────────────────────────────────────

fastify.post('/api/meetings', { preHandler: [requireAuth] }, async (request, reply) => {
  const { customer_id } = request.body || {};
  const repId = request.user.id;

  const result = await pool.query(
    `INSERT INTO meetings (customer_id, rep_id, status)
     VALUES ($1, $2, 'active')
     RETURNING *`,
    [customer_id || null, repId]
  );

  return reply.code(201).send(result.rows[0]);
});

fastify.get('/api/meetings', { preHandler: [requireAuth] }, async (request, reply) => {
  const { role, id } = request.user;
  let result;

  if (role === 'admin') {
    result = await pool.query(
      `SELECT m.*, u.name as rep_name, c.name as customer_name
       FROM meetings m
       LEFT JOIN users u ON m.rep_id = u.id
       LEFT JOIN customers c ON m.customer_id = c.id
       ORDER BY m.started_at DESC`
    );
  } else {
    result = await pool.query(
      `SELECT m.*, u.name as rep_name, c.name as customer_name
       FROM meetings m
       LEFT JOIN users u ON m.rep_id = u.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.rep_id = $1
       ORDER BY m.started_at DESC`,
      [id]
    );
  }

  return result.rows;
});

fastify.get('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const result = await pool.query(
    `SELECT m.*, u.name as rep_name, c.name as customer_name
     FROM meetings m
     LEFT JOIN users u ON m.rep_id = u.id
     LEFT JOIN customers c ON m.customer_id = c.id
     WHERE m.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = result.rows[0];

  // Reps can only see their own meetings
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  return meeting;
});

fastify.patch('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { status, ended_at, summary } = request.body || {};

  // Verify meeting exists and belongs to user (or admin)
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
  if (ended_at !== undefined) { updates.push(`ended_at = $${idx++}`); values.push(ended_at); }
  if (summary !== undefined) { updates.push(`summary = $${idx++}`); values.push(summary); }

  if (updates.length === 0) {
    return reply.code(400).send({ error: 'No fields to update' });
  }

  values.push(id);
  const result = await pool.query(
    `UPDATE meetings SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  return result.rows[0];
});

// ─── Phase 3: Coaching analysis ──────────────────────────────────────────────

const COACHING_SYSTEM_PROMPT = `You are ARIA, a real-time sales coaching assistant for CertaPro Painters field reps.

You have deep knowledge of:
1. The CertaPro 10+1 Sales Process (Setup Call → Follow Up)
2. The 1st Go Around checklist (13 required items)
3. The DISC buyer personality framework (D/Eagle, I/Parrot, S/Dove, C/Owl)

Analyze the transcript and return a JSON coaching object ONLY — no prose, no markdown, just raw JSON.

Detect:
- The prospect's DISC style from their speech patterns, pace, word choices, and intonation descriptions
- Which sales stage the rep is currently in
- Which checklist items have been covered vs missed

Return the exact JSON shape specified. Keep nudges short (under 10 words each). Keep tips under 15 words.`;

async function runCoachingAnalysis(meetingId) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

  // Fetch last 20 final transcript segments
  let segments;
  try {
    const segResult = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts DESC LIMIT 20`,
      [meetingId]
    );
    segments = segResult.rows.reverse();
  } catch (err) {
    console.error('coaching: DB error fetching segments:', err.message);
    return null;
  }

  if (segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

  const systemWithKB = `${COACHING_SYSTEM_PROMPT}\n\n=== DISC FRAMEWORK ===\n${kbDiscFramework}\n\n=== 10+1 SALES PROCESS ===\n${kb10Plus1Process}\n\n=== 1ST GO AROUND CHECKLIST ===\n${kbFirstGoAround}`;

  const userPrompt = `Meeting transcript (last ${segments.length} segments):\n\n${transcriptText}\n\nReturn ONLY raw JSON with this exact shape:\n{
  "disc": {
    "detected": "D",
    "confidence": "medium",
    "emoji": "🦅",
    "label": "Dominant (Eagle)",
    "tip": "Be direct, lead with outcomes"
  },
  "stage": {
    "current": "first_go_around",
    "label": "1st Go Around"
  },
  "checklist": [
    { "id": "scope", "label": "Confirm scope", "done": false },
    { "id": "why_now", "label": "Why now / motivation", "done": false },
    { "id": "colors", "label": "Color per area", "done": false },
    { "id": "primer_coats", "label": "Primer & coats", "done": false },
    { "id": "setup_prep", "label": "Setup & prep costs", "done": false },
    { "id": "carpentry", "label": "Carpentry / repairs", "done": false },
    { "id": "four_stages", "label": "4 stages of paint job", "done": false },
    { "id": "certainty_pledge", "label": "Certainty Pledge®", "done": false },
    { "id": "price_range", "label": "Price range", "done": false },
    { "id": "options", "label": "Options discussed", "done": false },
    { "id": "photos", "label": "Photo permission", "done": false }
  ],
  "nudges": ["Ask: why now?"],
  "urgent": null
}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aria.certaprograndhaven.com',
        'X-Title': 'ARIA Sales Helper',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemWithKB },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error('coaching: empty response from Claude');
      return null;
    }

    // Parse JSON — Claude may wrap in ```json fences
    let coaching;
    try {
      coaching = JSON.parse(rawContent);
    } catch {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        coaching = JSON.parse(jsonMatch[0]);
      } else {
        console.error('coaching: could not parse JSON from Claude response');
        return null;
      }
    }

    // Normalize: urgent must be string | null (Claude sometimes returns an object)
    if (coaching.urgent && typeof coaching.urgent === 'object') {
      coaching.urgent = coaching.urgent.message || coaching.urgent.flag || JSON.stringify(coaching.urgent);
    }

    // Persist snapshot
    try {
      await pool.query(
        `INSERT INTO coaching_snapshots (meeting_id, snapshot) VALUES ($1, $2)`,
        [meetingId, JSON.stringify(coaching)]
      );
    } catch (dbErr) {
      console.error('coaching: failed to save snapshot:', dbErr.message);
    }

    return coaching;
  } catch (err) {
    console.error('coaching: fetch/parse error:', err.message);
    return null;
  }
}

// POST /api/meetings/:id/coaching — manual trigger
fastify.post('/api/meetings/:id/coaching', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }
  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const coaching = await runCoachingAnalysis(id);
  if (!coaching) {
    return reply.code(503).send({ error: 'Coaching unavailable — not enough transcript or missing API key' });
  }

  return coaching;
});

// ─── Phase 2: Consent endpoint ────────────────────────────────────────────────
// POST /api/meetings/:id/consent — log consent confirmation

fastify.post('/api/meetings/:id/consent', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  // Verify meeting exists and belongs to user (or admin)
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const result = await pool.query(
    `UPDATE meetings SET consent_confirmed_at = NOW() WHERE id = $1 RETURNING consent_confirmed_at`,
    [id]
  );

  return { ok: true, consent_confirmed_at: result.rows[0].consent_confirmed_at };
});

// ─── Phase 2: Summary endpoint ────────────────────────────────────────────────
// POST /api/meetings/:id/summary — generate + store AI summary

fastify.post('/api/meetings/:id/summary', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  // Verify meeting
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  // Fetch transcript
  const segResult = await pool.query(
    `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );

  const segments = segResult.rows;
  let transcriptText = '';

  if (segments.length === 0) {
    transcriptText = '(No transcript recorded)';
  } else {
    transcriptText = segments
      .map(s => `${s.speaker}: ${s.text}`)
      .join('\n');
  }

  let summaryText;

  const summaryApiKey = ANTHROPIC_API_KEY || OPENROUTER_API_KEY;
  const summaryUrl = ANTHROPIC_API_KEY
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://openrouter.ai/api/v1/chat/completions';

  if (!summaryApiKey) {
    summaryText = '⚠️ Summary generation requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY. Please provision a key and try again.\n\n' +
      `Transcript preview (first 500 chars):\n${transcriptText.slice(0, 500)}`;
  } else if (OPENROUTER_API_KEY && !ANTHROPIC_API_KEY) {
    // Use OpenRouter via fetch (Anthropic SDK baseURL incompatibility)
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://aria.certaprograndhaven.com',
          'X-Title': 'ARIA Sales Helper'
        },
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-4-5',
          max_tokens: 1024,
          messages: [
            { role: 'system', content: 'You are a sales meeting assistant for a painting company. Summarize the meeting transcript and list 3-5 concrete action items for the sales rep.' },
            { role: 'user', content: `Transcript:\n${transcriptText}` }
          ]
        })
      });
      const orData = await orRes.json();
      summaryText = orData.choices?.[0]?.message?.content || 'Summary unavailable';
    } catch (err) {
      summaryText = `Summary generation failed: ${err.message}`;
    }
  } else {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: 'You are a sales meeting assistant for a painting company. Summarize the meeting transcript and list 3-5 concrete action items for the sales rep.',
        messages: [
          {
            role: 'user',
            content: `Here is the meeting transcript:\n\n${transcriptText}\n\nPlease provide a summary and 3-5 action items.`,
          },
        ],
      });
      summaryText = response.content[0].type === 'text' ? response.content[0].text : '(No summary generated)';
    } catch (err) {
      fastify.log.error('Anthropic summary error:', err);
      return reply.code(502).send({ error: 'Summary generation failed: ' + err.message });
    }
  }

  // Persist summary
  await pool.query(
    `UPDATE meetings SET summary = $1 WHERE id = $2`,
    [summaryText, id]
  );

  return { summary: summaryText };
});

// ─── Customer routes ──────────────────────────────────────────────────────────

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

  if (role === 'admin') {
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
  if (request.user.role !== 'admin' && customer.created_by !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  return customer;
});

// ─── Phase 2: WebSocket audio endpoint ───────────────────────────────────────
// GET /meetings/:id/audio → upgraded to WebSocket
// Accepts binary PCM audio (16 kHz linear16) from client
// Streams to Deepgram, broadcasts transcript events back

/**
 * Authenticate a WebSocket request via session cookie.
 * Returns user record or null.
 */
async function authWebSocket(request) {
  const cookieHeader = request.headers.cookie || '';
  // Parse cookies manually
  const cookies = {};
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });

  const sessionId = cookies['session_id'];
  const session = await getSession(sessionId);
  if (!session) return null;

  const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [session.userId]);
  return result.rows[0] || null;
}

fastify.get('/meetings/:meetingId/audio', { websocket: true }, async (socket, request) => {
  const { meetingId } = request.params;

  // Auth
  const user = await authWebSocket(request);
  if (!user) {
    socket.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
    socket.close(4001, 'Unauthorized');
    return;
  }

  // Verify meeting + ownership
  let meeting;
  try {
    const res = await pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
    if (res.rows.length === 0) {
      socket.send(JSON.stringify({ type: 'error', error: 'Meeting not found' }));
      socket.close(4004, 'Meeting not found');
      return;
    }
    meeting = res.rows[0];
    if (user.role !== 'admin' && meeting.rep_id !== user.id) {
      socket.send(JSON.stringify({ type: 'error', error: 'Forbidden' }));
      socket.close(4003, 'Forbidden');
      return;
    }
  } catch (err) {
    fastify.log.error('WS meeting lookup error:', err);
    socket.close(1011, 'Internal error');
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    socket.send(JSON.stringify({ type: 'error', error: 'Deepgram not configured on server' }));
    socket.close(1011, 'Deepgram not configured');
    return;
  }

  fastify.log.info(`WS audio: meeting ${meetingId} user ${user.id} connected`);

  // Register socket for coaching push
  registerMeetingSocket(meetingId, socket);

  // ── Open Deepgram streaming connection ────────────────────────────────────

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    diarize: 'true',
    interim_results: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  }).toString();

  let dgSocket = null;
  let dgReady = false;
  const audioQueue = []; // buffer while Deepgram reconnects
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  function connectDeepgram() {
    if (closed) return;

    dgSocket = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dgSocket.on('open', () => {
      dgReady = true;
      reconnectAttempts = 0;
      fastify.log.info(`Deepgram connected for meeting ${meetingId}`);

      // Flush queued audio
      const queued = audioQueue.splice(0);
      queued.forEach(buf => {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(buf);
        }
      });
    });

    dgSocket.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Deepgram results event
      if (msg.type !== 'Results') return;

      const alt = msg?.channel?.alternatives?.[0];
      if (!alt) return;

      const text = alt.transcript || '';
      if (!text.trim()) return;

      // Extract speaker from first word's speaker field (diarize)
      let speaker = 'Speaker';
      const words = alt.words || [];
      if (words.length > 0 && words[0].speaker !== undefined) {
        speaker = `Speaker ${words[0].speaker + 1}`; // 1-indexed for display
      }

      const isFinal = msg.is_final === true;

      if (isFinal) {
        // Persist to DB
        let segmentCount = 0;
        try {
          await pool.query(
            `INSERT INTO transcript_segments (meeting_id, ts, speaker, text)
             VALUES ($1, NOW(), $2, $3)`,
            [meetingId, speaker, text]
          );
          // Count total segments for coaching trigger threshold
          const countRes = await pool.query(
            `SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = $1`,
            [meetingId]
          );
          segmentCount = parseInt(countRes.rows[0].count, 10);
        } catch (dbErr) {
          fastify.log.error('transcript_segments insert error:', dbErr);
        }

        // Broadcast final result to client
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify({ type: 'final', text, speaker }));
        }

        // Phase 3: Auto-trigger coaching after every final segment (≥3 segments)
        if (segmentCount >= 3 && OPENROUTER_API_KEY) {
          // Fire-and-forget: run analysis async, push result via WS
          runCoachingAnalysis(meetingId)
            .then(coaching => {
              if (coaching) {
                broadcastToMeeting(meetingId, { type: 'coaching', data: coaching });
              }
            })
            .catch(err => {
              fastify.log.error('Auto-coaching error:', err.message);
            });
        }
      } else {
        // Broadcast interim result to client
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'interim', text, speaker }));
        }
      }
    });

    dgSocket.on('close', (code) => {
      dgReady = false;
      fastify.log.warn(`Deepgram closed (code=${code}) for meeting ${meetingId}`);

      if (!closed) {
        // Reconnect with backoff
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connectDeepgram, delay);
      }
    });

    dgSocket.on('error', (err) => {
      fastify.log.error('Deepgram WS error:', err.message);
    });
  }

  connectDeepgram();

  // ── Handle audio from client ──────────────────────────────────────────────

  socket.on('message', (data) => {
    if (dgReady && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(data);
    } else {
      // Buffer up to ~30s (16kHz, 16-bit mono = 32 bytes/ms → 960,000 bytes)
      const totalBuffered = audioQueue.reduce((s, b) => s + b.byteLength, 0);
      if (totalBuffered < 960_000) {
        audioQueue.push(Buffer.from(data));
      }
    }
  });

  // ── Client disconnected ───────────────────────────────────────────────────

  socket.on('close', () => {
    fastify.log.info(`WS client disconnected: meeting ${meetingId}`);
    closed = true;

    // Unregister from coaching push
    unregisterMeetingSocket(meetingId, socket);

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    // Send CloseStream to Deepgram for a clean finish
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      try {
        dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => dgSocket.terminate(), 2000);
      } catch {
        dgSocket.terminate();
      }
    }
  });

  socket.on('error', (err) => {
    fastify.log.error('Client WS error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await loadKnowledgeBase();
  await ensureSessionsTable();
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`ARIA server running on port ${PORT}`);
  console.log(`WebSocket audio endpoint: ws://localhost:${PORT}/meetings/:id/audio`);
  console.log(`Coaching endpoint: POST /api/meetings/:id/coaching`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
