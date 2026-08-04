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
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import WebSocket from 'ws';
import { extractVoiceFeatures, similarityScore } from './voiceFeatures.js';
import { createMeetingDoc } from './googleDocs.js';

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
  // speaker_labels column on meetings (added 2026-07-17)
  await pool.query(`
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_labels JSONB DEFAULT '{}'
  `);
  // Word cadence / sequencing analytics (added 2026-08-02)
  await pool.query(`
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS word_count INTEGER
  `);
  await pool.query(`
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS duration_ms INTEGER
  `);
  // Voice fingerprints table (Phase 5)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_prints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      features JSONB NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id)
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

// Root route for Railway health check
fastify.get('/', async (request, reply) => {
  return reply.code(200).send({ ok: true });
});

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
      // Mobile-only fallback (see authWebSocket note above) — the web PWA's
      // fetch client never reads this field and continues to rely solely on
      // the httpOnly cookie, so this is not a new client-readable-cookie
      // security regression for the web app. It IS a new client-visible
      // credential for the mobile app specifically; mobile stores it in
      // expo-secure-store (OS-level encrypted storage), not plain state.
      sessionId,
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
  // Mobile-only session-id backfill (2026-08-04): the native-client WS auth
  // fallback (see authWebSocket()) requires the raw session id, which is
  // only ever handed to the client in the /api/auth/login response body.
  // Any mobile session established BEFORE that fallback shipped (or any
  // future case where secure-store gets cleared without a fresh login) has
  // no sessionId cached, silently falling back to cookie-only WS auth --
  // the exact bug this was meant to fix. Returning it here too lets the
  // mobile client backfill it on every authenticated app-open, without
  // forcing a log-out/log-in cycle. The web PWA's api.ts ignores unknown
  // response fields, so this is additive and does not change its behavior.
  return { user: request.user, sessionId: request.cookies?.session_id };
});

// ─── Voice print routes ─────────────────────────────────────────────────────────

// GET /api/profile/voice-print — check enrollment status
fastify.get('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  const result = await pool.query(
    'SELECT id, duration_ms, created_at FROM voice_prints WHERE user_id = $1',
    [request.user.id]
  );
  if (result.rows.length === 0) return { enrolled: false };
  const vp = result.rows[0];
  return { enrolled: true, duration_ms: vp.duration_ms, created_at: vp.created_at };
});

// POST /api/profile/voice-print — enroll or re-enroll
// Body: { features: {...}, duration_ms: number }
fastify.post('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  const { features, duration_ms } = request.body || {};
  if (!features || !duration_ms) return reply.code(400).send({ error: 'features and duration_ms required' });
  // Upsert — one print per user
  await pool.query(
    `INSERT INTO voice_prints (user_id, features, duration_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET features = $2, duration_ms = $3, created_at = NOW()`,
    [request.user.id, JSON.stringify(features), duration_ms]
  );
  return { ok: true };
});

// DELETE /api/profile/voice-print — remove enrollment
fastify.delete('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  await pool.query('DELETE FROM voice_prints WHERE user_id = $1', [request.user.id]);
  return { ok: true };
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
  const { status, ended_at, summary, title, speaker_labels } = request.body || {};

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
  if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(title); }
  if (speaker_labels !== undefined) { updates.push(`speaker_labels = $${idx++}`); values.push(JSON.stringify(speaker_labels)); }

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

FIELD GUIDANCE:
- disc.tip: Static one-liner on how to sell to this style (under 15 words). Example: "Lead with ROI, skip the story."
- nudges: 1-4 short action items for what the rep should do next (under 10 words each).
- urgent: DISC-based situational coaching — if you detect the rep made a misstep, missed a read on the prospect's style, or the conversation is drifting off track, write a brief recovery tip here (1-2 sentences max). Base it on what you know about this prospect's DISC style. Examples: "This Dove is pulling back — slow down and reassure before asking for price range." / "You over-explained to an Eagle — pivot to options and let them choose." / "The Owl asked for specifics you didn't answer — loop back and give the exact detail." Set to null if the conversation is on track and no correction is needed.

Return the exact JSON shape specified.`;

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
      // Strip markdown fences and try again
      const stripped = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      try {
        coaching = JSON.parse(stripped);
      } catch {
        // Extract first {...} block and repair common issues (trailing commas)
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const repaired = jsonMatch[0]
              .replace(/,\s*([}\]])/g, '$1')  // trailing commas
              .replace(/([{,]\s*)(\w+):/g, '$1"$2":'); // unquoted keys
            coaching = JSON.parse(repaired);
          } catch {
            console.error('coaching: could not parse JSON from Claude response');
            return null;
          }
        } else {
          console.error('coaching: no JSON object found in Claude response');
          return null;
        }
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

// GET /api/meetings/:id/coaching/latest — fetch latest coaching snapshot with merged sticky checklist
fastify.get('/api/meetings/:id/coaching/latest', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  if (request.user.role !== 'admin' && existing.rows[0].rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  // Get all snapshots and merge checklist — once done always done
  const result = await pool.query(
    `SELECT snapshot FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  if (result.rows.length === 0) return { coaching: null };

  // Start from latest snapshot, then OR in all previously-checked items
  const latest = result.rows[result.rows.length - 1].snapshot;
  const checkedIds = new Set();
  for (const row of result.rows) {
    for (const item of row.snapshot.checklist || []) {
      if (item.done) checkedIds.add(item.id);
    }
  }
  const merged = (latest.checklist || []).map(item => ({
    ...item,
    done: item.done || checkedIds.has(item.id),
  }));
  return { coaching: { ...latest, checklist: merged } };
});

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

// ─── Post-meeting analytics: WPM, checklist sequencing/timing, Meeting Score ──
// GET /api/meetings/:id/analytics
// Computed entirely from data already captured (Deepgram word timestamps
// stored per transcript_segment + the coaching_snapshots history) — no new
// vendor/infra required.

const CHECKLIST_IDEAL_ORDER = [
  'scope', 'why_now', 'colors', 'primer_coats', 'setup_prep', 'carpentry',
  'four_stages', 'certainty_pledge', 'price_range', 'options', 'photos',
];
const WPM_IDEAL_MIN = 120;
const WPM_IDEAL_MAX = 160;
const CRITICAL_CHECKLIST_ITEMS = ['scope', 'price_range'];
const LATE_CRITICAL_THRESHOLD = 0.7; // flag if hit past 70% of meeting duration

// Longest-increasing-subsequence ratio: what fraction of the rep's actually-
// hit checklist items appear in an order consistent with the ideal sequence.
// 1.0 = perfectly ordered, lower = more items covered out of sequence.
function sequenceMatchRatio(actualOrderIds, idealOrderIds) {
  if (actualOrderIds.length === 0) return 1;
  const idealIndex = new Map(idealOrderIds.map((id, i) => [id, i]));
  const indices = actualOrderIds.map(id => idealIndex.get(id)).filter(i => i !== undefined);
  if (indices.length === 0) return 0;
  const tails = [];
  for (const num of indices) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < num) lo = mid + 1; else hi = mid;
    }
    if (lo === tails.length) tails.push(num); else tails[lo] = num;
  }
  return tails.length / indices.length;
}

fastify.get('/api/meetings/:id/analytics', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const repResult = await pool.query('SELECT name FROM users WHERE id = $1', [meeting.rep_id]);
  const repName = repResult.rows[0]?.name || null;

  const segResult = await pool.query(
    `SELECT speaker, text, ts, word_count, duration_ms FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;

  const meetingStart = meeting.started_at
    ? new Date(meeting.started_at).getTime()
    : (segments[0] ? new Date(segments[0].ts).getTime() : Date.now());
  const meetingEnd = meeting.ended_at
    ? new Date(meeting.ended_at).getTime()
    : (segments.length ? new Date(segments[segments.length - 1].ts).getTime() : Date.now());
  const meetingDurationMin = Math.max(1, (meetingEnd - meetingStart) / 60000);

  // ── Word cadence / WPM ────────────────────────────────────────────────────
  // Only counts segments attributed to the rep's resolved display name, and
  // only segments with real Deepgram word timing (duration_ms populated) —
  // the pre-migration/fallback rows without timing are silently excluded
  // rather than skewing the average.
  const repSegments = segments.filter(s => repName && s.speaker === repName);
  let totalRepWords = 0;
  let totalRepDurationMs = 0;
  const wpmBuckets = new Map(); // minute-of-call -> { words, durationMs }
  for (const seg of repSegments) {
    if (!seg.word_count || !seg.duration_ms || seg.duration_ms <= 0) continue;
    totalRepWords += seg.word_count;
    totalRepDurationMs += seg.duration_ms;
    const minuteBucket = Math.max(0, Math.floor((new Date(seg.ts).getTime() - meetingStart) / 60000));
    const bucket = wpmBuckets.get(minuteBucket) || { words: 0, durationMs: 0 };
    bucket.words += seg.word_count;
    bucket.durationMs += seg.duration_ms;
    wpmBuckets.set(minuteBucket, bucket);
  }
  const avgWpm = totalRepDurationMs > 0
    ? Math.round((totalRepWords / (totalRepDurationMs / 1000)) * 60)
    : null;
  const wpmOverTime = Array.from(wpmBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([minute, b]) => ({
      minute,
      wpm: b.durationMs > 0 ? Math.round((b.words / (b.durationMs / 1000)) * 60) : null,
    }))
    .filter(p => p.wpm !== null);

  let paceFlag = null;
  if (avgWpm !== null) {
    paceFlag = avgWpm < WPM_IDEAL_MIN ? 'slow' : avgWpm > WPM_IDEAL_MAX ? 'fast' : 'good';
  }

  // ── Checklist sequencing / timing ─────────────────────────────────────────
  // "When", not just "if": walk the full coaching-snapshot history (already
  // persisted every ~3 segments during the live call) and find the earliest
  // snapshot where each item flipped to done.
  const snapResult = await pool.query(
    `SELECT snapshot, created_at FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  const snapshots = snapResult.rows;

  const firstHitAt = {}; // item id -> Date it first showed done=true
  for (const row of snapshots) {
    for (const item of row.snapshot?.checklist || []) {
      if (item.done && firstHitAt[item.id] === undefined) firstHitAt[item.id] = row.created_at;
    }
  }

  const latestChecklist = snapshots.length > 0 ? (snapshots[snapshots.length - 1].snapshot?.checklist || []) : [];
  const checklistTiming = CHECKLIST_IDEAL_ORDER.map(itemId => {
    const hitAt = firstHitAt[itemId];
    const labelRow = latestChecklist.find(i => i.id === itemId);
    return {
      id: itemId,
      label: labelRow?.label || itemId,
      hit: hitAt !== undefined,
      minutesIn: hitAt !== undefined ? Math.round((new Date(hitAt).getTime() - meetingStart) / 60000) : null,
    };
  });

  const actualOrderIds = checklistTiming
    .filter(c => c.hit)
    .sort((a, b) => (a.minutesIn ?? 0) - (b.minutesIn ?? 0))
    .map(c => c.id);
  const sequenceScoreRatio = sequenceMatchRatio(actualOrderIds, CHECKLIST_IDEAL_ORDER);

  const lateCriticalItems = checklistTiming
    .filter(c => CRITICAL_CHECKLIST_ITEMS.includes(c.id) && c.hit && c.minutesIn !== null)
    .filter(c => (c.minutesIn / meetingDurationMin) > LATE_CRITICAL_THRESHOLD)
    .map(c => ({ id: c.id, label: c.label, minutesIn: c.minutesIn }));

  const coveredCount = checklistTiming.filter(c => c.hit).length;
  const coveragePct = Math.round((coveredCount / CHECKLIST_IDEAL_ORDER.length) * 100);

  // ── DISC adaptation quality ────────────────────────────────────────────────
  // Approximated from how often the coaching engine had to raise an "urgent"
  // situational correction — fewer corrections needed across the call implies
  // better real-time adaptation to the prospect's detected style.
  const urgentCount = snapshots.filter(row => row.snapshot?.urgent).length;
  const discAdaptationScore = snapshots.length > 0
    ? Math.round(Math.max(0, 1 - (urgentCount / snapshots.length)) * 100)
    : null;

  // ── Composite Meeting Score card ──────────────────────────────────────────
  const paceScore = paceFlag === null ? null : (paceFlag === 'good' ? 100 : 60);
  const scoreComponents = [
    { key: 'coverage', label: 'Checklist Coverage', value: coveragePct, weight: 0.35 },
    { key: 'sequencing', label: 'Sequence Order', value: Math.round(sequenceScoreRatio * 100), weight: 0.25 },
    { key: 'pacing', label: 'Speaking Pace', value: paceScore, weight: 0.20 },
    { key: 'disc_adaptation', label: 'DISC Adaptation', value: discAdaptationScore, weight: 0.20 },
  ].filter(c => c.value !== null);

  const totalWeight = scoreComponents.reduce((s, c) => s + c.weight, 0);
  const meetingScore = totalWeight > 0
    ? Math.round(scoreComponents.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight)
    : null;

  return {
    wpm: {
      avg: avgWpm,
      idealMin: WPM_IDEAL_MIN,
      idealMax: WPM_IDEAL_MAX,
      paceFlag,
      overTime: wpmOverTime,
    },
    checklistTiming,
    sequencing: {
      score: Math.round(sequenceScoreRatio * 100),
      actualOrder: actualOrderIds,
      idealOrder: CHECKLIST_IDEAL_ORDER,
      lateCriticalItems,
    },
    coveragePct,
    discAdaptationScore,
    meetingScore,
    scoreComponents,
  };
});

// ─── Phase 2: Consent endpoint ────────────────────────────────────────────────
// DELETE /api/meetings/:id
fastify.delete('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  await pool.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [id]);
  await pool.query('DELETE FROM coaching_snapshots WHERE meeting_id = $1', [id]);
  await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
  return { ok: true };
});

// GET /api/meetings/:id/segments — fetch saved transcript segments
fastify.get('/api/meetings/:id/segments', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const result = await pool.query(
    `SELECT speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  return { segments: result.rows };
});

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

fastify.post('/api/meetings/:id/summary', { preHandler: [requireAuth], config: { rawBody: false } }, async (request, reply) => {
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

  // Also pull the latest coaching snapshot to know which checklist items were hit
  const coachingResult = await pool.query(
    `SELECT snapshot FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  const lastCoaching = coachingResult.rows[0]?.snapshot || null;
  const checklist = lastCoaching?.checklist || [];
  const hitItems = checklist.filter(i => i.done).map(i => i.label);
  const missedItems = checklist.filter(i => !i.done).map(i => i.label);
  const detectedStage = lastCoaching?.stage?.label || 'Unknown';

  const SUMMARY_SYSTEM = `You are ARIA, a sales coach for CertaPro Painters field reps.
You have deep knowledge of:
1. The CertaPro 10+1 Sales Process (11 stages: Setup Call, Arrival, Upfront 4, 1st Go Around, Client Manual, 2nd Go Around, Rough Estimate, Prepare Proposal, Proposal Presentation, Ask for the Order, Follow Up)
2. The 1st Go Around checklist (11 required items the rep must cover)

=== 10+1 SALES PROCESS ===
${kb10Plus1Process}

=== 1ST GO AROUND CHECKLIST ===
${kbFirstGoAround}`;

  const checklistContext = checklist.length > 0
    ? `\n\nChecklist items COVERED during this meeting: ${hitItems.length > 0 ? hitItems.join(', ') : 'None detected'}\nChecklist items MISSED: ${missedItems.length > 0 ? missedItems.join(', ') : 'None — all covered'}\nLast detected sales stage: ${detectedStage}`
    : '';

  const SUMMARY_USER = `Meeting transcript:\n\n${transcriptText}${checklistContext}\n\nWrite a structured meeting summary with these sections (plain text, no markdown asterisks or symbols):\n\n1. MEETING OVERVIEW\nBrief 2-3 sentence summary of what was discussed.\n\n2. SALES STAGE\nWhich of the 11 sales stages was reached and how far the rep got through the process.\n\n3. CHECKLIST COVERAGE\nList each 1st Go Around checklist item and whether it was covered or missed. Be specific about what was said or skipped.\n\n4. WHAT WAS MISSED\nClearly call out any checklist items or required sales stages the rep did not complete, and why it matters.\n\n5. ACTION ITEMS\n3-5 concrete next steps for the rep to follow up on.`;

  if (!summaryApiKey) {
    summaryText = '⚠️ Summary generation requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY. Please provision a key and try again.\n\n' +
      `Transcript preview (first 500 chars):\n${transcriptText.slice(0, 500)}`;
  } else if (OPENROUTER_API_KEY && !ANTHROPIC_API_KEY) {
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
          max_tokens: 1500,
          messages: [
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: SUMMARY_USER }
          ]
        })
      });
      const orData = await orRes.json();
      if (!orRes.ok) {
        fastify.log.error('OpenRouter summary error:', JSON.stringify(orData));
        return reply.code(502).send({ error: `Summary failed: ${orData.error?.message || orRes.status}` });
      }
      summaryText = orData.choices?.[0]?.message?.content || 'Summary unavailable';
    } catch (err) {
      summaryText = `Summary generation failed: ${err.message}`;
    }
  } else {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1500,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: SUMMARY_USER }],
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

// Extract just the "ACTION ITEMS" section out of a generated summary text.
// Mirrors the frontend's extractActionItems() in MeetingPage.tsx so the
// exported Google Doc's action-items section matches what reps already see.
function extractActionItemsServer(summaryText) {
  if (!summaryText) return null;
  const lines = summaryText.split('\n');
  const startIdx = lines.findIndex(l => /action items/i.test(l));
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex(l => /^\s*\d+\.\s+[A-Z]/.test(l));
  const body = (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n').trim();
  return body || null;
}

// POST /api/meetings/:id/export-to-docs — create a Google Doc with the
// meeting's summary/action items/transcript and share it with the requesting
// user's real email address.
fastify.post('/api/meetings/:id/export-to-docs', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query(
    `SELECT m.*, c.name as customer_name
     FROM meetings m
     LEFT JOIN customers c ON m.customer_id = c.id
     WHERE m.id = $1`,
    [id]
  );
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (request.user.role !== 'admin' && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return reply.code(503).send({ error: 'Google Docs export is not configured (missing GOOGLE_SERVICE_ACCOUNT_JSON).' });
  }

  const userEmail = request.user.email;
  if (!userEmail) {
    return reply.code(400).send({ error: 'Your account has no email on file — cannot share the doc.' });
  }

  // Fetch transcript (same query pattern as the /summary endpoint)
  const segResult = await pool.query(
    `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;
  const transcriptText = segments.length === 0
    ? '(No transcript recorded)'
    : segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

  const summaryText = meeting.summary || '(No summary generated yet)';
  const actionItems = extractActionItemsServer(meeting.summary || '');

  const displayTitle = meeting.title || meeting.customer_name || 'Meeting';
  const meetingDate = new Date(meeting.started_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const docTitle = `${displayTitle} — ${meetingDate}`;

  const contentLines = [];
  contentLines.push(docTitle);
  if (meeting.customer_name) contentLines.push(`Customer: ${meeting.customer_name}`);
  contentLines.push(`Date: ${meetingDate}`);
  contentLines.push('');
  contentLines.push('SUMMARY');
  contentLines.push('─'.repeat(40));
  contentLines.push(summaryText.replace(/\*/g, ''));
  contentLines.push('');
  if (actionItems) {
    contentLines.push('ACTION ITEMS');
    contentLines.push('─'.repeat(40));
    contentLines.push(actionItems);
    contentLines.push('');
  }
  contentLines.push('TRANSCRIPT');
  contentLines.push('─'.repeat(40));
  contentLines.push(transcriptText);
  contentLines.push('');
  contentLines.push('Generated by ARIA — CertaPro Grand Haven');

  const content = contentLines.join('\n');

  try {
    const { docId, webViewLink } = await createMeetingDoc(docTitle, content, userEmail);
    return { docId, webViewLink };
  } catch (err) {
    fastify.log.error('export-to-docs error:', err);
    return reply.code(502).send({ error: 'Failed to create Google Doc: ' + err.message });
  }
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

  // Native-client fallback (2026-08-03): React Native's WebSocket upgrade
  // request does not reliably carry the httpOnly session_id cookie the way
  // a browser's does (this was flagged as an open risk when the mobile app
  // was scaffolded, now confirmed in practice on a real device). Since the
  // cookie is httpOnly, the mobile client can't read and resend it manually
  // either — so the login response now also returns the raw session id in
  // the JSON body (mobile-only; the web PWA ignores that field and keeps
  // using the cookie as before), and the mobile WS client passes it as a
  // `?session=` query param on the upgrade request. Cookie auth remains the
  // primary/preferred path for the web app; this is strictly additive.
  const sessionId = cookies['session_id'] || request.query?.session;
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

  // ── Voice fingerprint matching setup ──────────────────────────────────────
  let enrolledFeatures = null;
  let repName = user.name || 'Rep';
  const vpResult = await pool.query(
    'SELECT features FROM voice_prints WHERE user_id = $1', [user.id]
  );
  if (vpResult.rows.length > 0) {
    enrolledFeatures = vpResult.rows[0].features;
    fastify.log.info(`Voice print loaded for ${repName}`);
  }

  // Rolling audio ring buffer (16kHz) — always active, independent of rep
  // enrollment. Feeds both rep-voiceprint matching and speaker de-duplication
  // below. A 60s window comfortably covers Deepgram's processing latency
  // without buffering an entire (potentially hour-long) call in memory.
  const RING_SECONDS = 60;
  const RING_SAMPLES = 16000 * RING_SECONDS;
  const voiceRing = new Float32Array(RING_SAMPLES);
  let ringPos = 0;
  let ringWritten = 0;

  function ringWrite(int16) {
    for (let i = 0; i < int16.length; i++) {
      voiceRing[ringPos] = int16[i] / 32768;
      ringPos = (ringPos + 1) % RING_SAMPLES;
      ringWritten++;
    }
  }

  // Slice absolute-sample range [fromAbs, toAbs) out of the ring buffer.
  // Returns null if the range is invalid, not yet written, or already
  // overwritten (fell outside the rolling window).
  function ringSlice(fromAbs, toAbs) {
    fromAbs = Math.max(0, Math.floor(fromAbs));
    toAbs = Math.min(ringWritten, Math.ceil(toAbs));
    if (toAbs <= fromAbs) return null;
    const len = toAbs - fromAbs;
    if (len > RING_SAMPLES || ringWritten - fromAbs > RING_SAMPLES) return null;
    const out = new Float32Array(len);
    const startPos = ((fromAbs % RING_SAMPLES) + RING_SAMPLES) % RING_SAMPLES;
    for (let i = 0; i < len; i++) out[i] = voiceRing[(startPos + i) % RING_SAMPLES];
    return out;
  }

  const speakerChunks = {}; // canonical speaker id -> Float32Array[] (rep-voiceprint match)
  const speakerLocks = {};  // canonical speaker id (string) -> displayName
  let voiceMatchDone = false;
  const MIN_MATCH_SAMPLES = 16000 * 5;  // 5s per speaker before a candidate is eligible
  const MATCH_THRESHOLD = 0.72;         // raised from 0.58 — tighter bar, fewer false positives

  // ── Wait-and-compare rep-match locking (fixes first-past-post mislabeling) ───
  // Old behavior locked onto whichever speaker slot crossed the threshold
  // FIRST, even if that slot was actually the customer. Instead: once a
  // candidate is eligible, hold the decision open for a grace window so any
  // other active speaker can also become eligible, then lock onto whichever
  // scores highest — and only if it clears the raised threshold AND beats
  // the runner-up by a real margin (not just clearing an absolute bar).
  const candidateScores = {};      // canonical si (string) -> latest similarity score
  const candidateReadyAt = {};     // canonical si (string) -> ms timestamp first became eligible
  let matchGraceDeadline = null;   // ms timestamp; decide once we reach this (or max-wait)
  const MATCH_GRACE_MS = 4000;     // base wait for a second candidate to catch up
  const MATCH_GRACE_EXTEND_MS = 1500; // extra wait granted when top two are close
  const MATCH_MAX_WAIT_MS = 15000; // hard cap from first-eligible candidate — don't wait forever
  const MATCH_MARGIN = 0.08;       // top must beat runner-up by this much to lock early

  // ── Drift re-verification ("is the lock still correct?") ───────────────
  // A bad initial lock previously stuck for the entire call (voiceMatchDone
  // disabled all further checking). Now: keep sampling the locked speaker's
  // ongoing audio and periodically re-score against the enrolled print. If
  // confidence collapses — wrong initial lock, or Deepgram silently
  // re-indexed speaker slots mid-call — unlock and let the matcher
  // re-evaluate from scratch.
  let lockedSpeakerId = null;
  let driftChunks = [];
  let lastDriftCheckAt = 0;
  const DRIFT_CHECK_INTERVAL_MS = 25000; // re-check roughly every 25s of locked speech
  const DRIFT_MIN_SAMPLES = 16000 * 4;   // need 4s of fresh locked-speaker audio to re-check
  const DRIFT_UNLOCK_THRESHOLD = 0.45;   // below this, assume mismatch/drift — unlock

  // ── Speaker de-duplication (merge over-segmented speaker indices) ─────────
  // Deepgram's streaming diarizer can spawn a "new" speaker index mid-call
  // for the same person (pause, pitch/cadence shift, background noise). Before
  // trusting a raw index as genuinely new, compare its accumulated audio
  // against already-established speaker reference fingerprints and merge if
  // it's really the same voice. Threshold is intentionally stricter than the
  // rep-match threshold — falsely merging two DIFFERENT real people would be
  // worse than leaving an over-segmented split alone.
  const speakerAlias = {};        // rawSi -> canonical Si (once resolved as a merge)
  const speakerRefFeatures = {};  // canonical Si -> reference voice features
  const speakerRefChunks = {};    // rawSi -> Float32Array[] (pending, pre-resolution)
  const DEDUP_MIN_SAMPLES = 16000 * 3; // 3s before attempting a merge check
  // Raised 0.80 -> 0.92 (2026-08-03): the underlying spectral-feature matcher
  // (centroid/rolloff/zcr/energy/spread) is too coarse to reliably discriminate
  // between two DIFFERENT real people on the same mic/room, especially over
  // short clips — was causing distinct customer voices to be falsely merged
  // into whichever speaker slot became canonical first (frequently the rep).
  // This is a stopgap; the real fix is replacing this matcher with a proper
  // voice-embedding model (pyannoteAI), planned for the Aria Phone Channel
  // work and worth extending to this in-person pipeline too.
  const DEDUP_MERGE_THRESHOLD = 0.92;  // stricter bar than rep-match (0.58)

  function resolveSpeaker(rawSi) {
    let cur = rawSi;
    let hops = 0;
    while (speakerAlias[cur] !== undefined && hops < 8) {
      cur = speakerAlias[cur];
      hops++;
    }
    return cur;
  }

  async function maybeMergeSpeaker(rawSi) {
    if (speakerAlias[rawSi] !== undefined) return; // already resolved
    if (speakerRefFeatures[rawSi] !== undefined) return; // already its own canonical
    const chunks = speakerRefChunks[rawSi];
    if (!chunks) return;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (total < DEDUP_MIN_SAMPLES) return;

    const combined = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.length; }
    const features = extractVoiceFeatures(combined);

    let bestMatch = null;
    let bestScore = 0;
    for (const [canonicalSi, refFeatures] of Object.entries(speakerRefFeatures)) {
      if (Number(canonicalSi) === rawSi) continue;
      // Never merge a new/unresolved speaker into the currently-locked rep slot.
      // Previously any voice scoring high enough against the rep's fingerprint
      // (even a different real person, given the matcher's weak discrimination)
      // would get silently relabeled as the rep. The rep's identity is already
      // established via the dedicated voiceprint-lock flow above — this merge
      // step should only ever consolidate customer-side over-segmentation, not
      // reassign someone else's voice onto the rep.
      if (lockedSpeakerId !== null && Number(canonicalSi) === Number(lockedSpeakerId)) continue;
      const score = similarityScore(features, refFeatures);
      if (score > bestScore) { bestScore = score; bestMatch = Number(canonicalSi); }
    }

    if (bestMatch !== null && bestScore >= DEDUP_MERGE_THRESHOLD) {
      speakerAlias[rawSi] = bestMatch;
      fastify.log.info(`Speaker dedup: Speaker ${rawSi + 1} merged into Speaker ${bestMatch + 1} (score=${bestScore.toFixed(3)})`);

      const staleLabel = speakerLocks[String(rawSi)] || `Speaker ${rawSi + 1}`;
      const canonicalLabel = speakerLocks[String(bestMatch)] || `Speaker ${bestMatch + 1}`;
      if (staleLabel !== canonicalLabel) {
        try {
          await pool.query(
            `UPDATE transcript_segments SET speaker = $1 WHERE meeting_id = $2 AND speaker = $3`,
            [canonicalLabel, meetingId, staleLabel]
          );
        } catch (dbErr) {
          fastify.log.error('transcript_segments relabel error:', dbErr);
        }
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'speaker_merge', from: staleLabel, to: canonicalLabel }));
        }
      }
      delete speakerRefChunks[rawSi];
    } else {
      speakerRefFeatures[rawSi] = features;
      delete speakerRefChunks[rawSi];
    }
  }

  // ── Open Deepgram streaming connection (nova-3 + latest diarization model) ────

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    diarize_model: 'latest',   // latest GA diarizer — best accuracy, supersedes diarize=true
    interim_results: 'true',
    utterance_end_ms: '1000',  // flush utterance after 1s silence for tighter segments
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  }).toString();

  let dgSocket = null;
  let dgReady = false;
  const audioQueue = [];
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
      const queued = audioQueue.splice(0);
      queued.forEach(buf => {
        if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(buf);
      });
    });

    dgSocket.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type !== 'Results') return;

      const alt = msg?.channel?.alternatives?.[0];
      if (!alt) return;

      const text = (alt.transcript || '').trim();
      if (!text) return;

      // Extract speaker from word-level diarization (1-indexed for display)
      // — resolved through the de-dup alias map so an over-segmented "new"
      // index that's really the same person collapses to its canonical id.
      const words = alt.words || [];
      let rawSpeakerIdx = resolveSpeaker(words.length > 0 && words[0].speaker !== undefined ? words[0].speaker : 0);
      let speaker = speakerLocks[String(rawSpeakerIdx)] || `Speaker ${rawSpeakerIdx + 1}`;

      // Feed per-word audio slices into the de-dup accumulator (always) and
      // the rep-voiceprint accumulator (only while a rep fingerprint is
      // enrolled and not yet matched).
      if (words.length > 0) {
        for (const word of words) {
          if (word.start === undefined || word.end === undefined) continue;
          const rawSi = word.speaker ?? 0;
          const wordAudio = ringSlice(word.start * 16000, word.end * 16000);
          if (!wordAudio || wordAudio.length < 100) continue;

          // De-dup accumulation (raw index, pre-resolution)
          if (speakerAlias[rawSi] === undefined && speakerRefFeatures[rawSi] === undefined) {
            if (!speakerRefChunks[rawSi]) speakerRefChunks[rawSi] = [];
            speakerRefChunks[rawSi].push(wordAudio);
            await maybeMergeSpeaker(rawSi);
          }

          // Rep-voiceprint accumulation (resolved/canonical index)
          if (enrolledFeatures && !voiceMatchDone) {
            const canonicalSi = String(resolveSpeaker(rawSi));
            if (!speakerChunks[canonicalSi]) speakerChunks[canonicalSi] = [];
            speakerChunks[canonicalSi].push(wordAudio);
          }

          // Drift re-verification accumulation (only for the currently-locked
          // rep speaker, only after a lock exists)
          if (enrolledFeatures && voiceMatchDone && lockedSpeakerId !== null) {
            const canonicalSi = String(resolveSpeaker(rawSi));
            if (canonicalSi === lockedSpeakerId) {
              driftChunks.push(wordAudio);
            }
          }
        }

        // ── Wait-and-compare: evaluate rep-match candidates, lock on best-with-margin ──
        if (enrolledFeatures && !voiceMatchDone) {
          const now = Date.now();
          for (const [si, chunks] of Object.entries(speakerChunks)) {
            if (speakerLocks[si]) continue;
            const total = chunks.reduce((s, c) => s + c.length, 0);
            if (total < MIN_MATCH_SAMPLES) continue;
            const combined = new Float32Array(total);
            let off = 0;
            for (const c of chunks) { combined.set(c, off); off += c.length; }
            const features = extractVoiceFeatures(combined);
            const score = similarityScore(features, enrolledFeatures);
            candidateScores[si] = score;
            if (candidateReadyAt[si] === undefined) candidateReadyAt[si] = now;
            if (matchGraceDeadline === null) matchGraceDeadline = now + MATCH_GRACE_MS;
            fastify.log.info(`Voice match candidate Speaker ${si}: score=${score.toFixed(3)}`);
          }

          if (matchGraceDeadline !== null && Object.keys(candidateScores).length > 0) {
            const earliestReady = Math.min(...Object.values(candidateReadyAt));
            const pastGrace = now >= matchGraceDeadline;
            const pastMaxWait = now - earliestReady >= MATCH_MAX_WAIT_MS;

            if (pastGrace || pastMaxWait) {
              const ranked = Object.entries(candidateScores).sort((a, b) => b[1] - a[1]);
              const [bestSi, bestScore] = ranked[0];
              const secondScore = ranked.length > 1 ? ranked[1][1] : null;
              const marginOk = secondScore === null || (bestScore - secondScore) >= MATCH_MARGIN;

              if (bestScore >= MATCH_THRESHOLD && (marginOk || pastMaxWait)) {
                speakerLocks[bestSi] = repName;
                voiceMatchDone = true;
                lockedSpeakerId = bestSi;
                lastDriftCheckAt = now;
                driftChunks = [];
                fastify.log.info(
                  `Voice match: Speaker ${bestSi} → ${repName} (score=${bestScore.toFixed(3)}, ` +
                  `margin=${secondScore !== null ? (bestScore - secondScore).toFixed(3) : 'n/a'}, ` +
                  `waited=${now - earliestReady}ms)`
                );
                if (socket.readyState === 1) {
                  socket.send(JSON.stringify({
                    type: 'speaker_lock',
                    speakerId: `Speaker ${parseInt(bestSi, 10) + 1}`,
                    name: repName,
                  }));
                }
              } else if (!marginOk && !pastMaxWait) {
                // Close race between two candidates — give it a bit more audio
                // before forcing a decision.
                matchGraceDeadline = now + MATCH_GRACE_EXTEND_MS;
              }
            }
          }
        } else if (enrolledFeatures && voiceMatchDone && lockedSpeakerId !== null) {
          // ── Drift re-verification: is the lock still holding up? ──
          const driftTotal = driftChunks.reduce((s, c) => s + c.length, 0);
          const now = Date.now();
          if (driftTotal >= DRIFT_MIN_SAMPLES && (now - lastDriftCheckAt) >= DRIFT_CHECK_INTERVAL_MS) {
            const combined = new Float32Array(driftTotal);
            let off = 0;
            for (const c of driftChunks) { combined.set(c, off); off += c.length; }
            const features = extractVoiceFeatures(combined);
            const score = similarityScore(features, enrolledFeatures);
            lastDriftCheckAt = now;
            driftChunks = [];
            fastify.log.info(`Drift check Speaker ${lockedSpeakerId}: score=${score.toFixed(3)}`);
            if (score < DRIFT_UNLOCK_THRESHOLD) {
              fastify.log.warn(`Voice match drift detected — unlocking Speaker ${lockedSpeakerId} (score=${score.toFixed(3)})`);
              delete speakerLocks[lockedSpeakerId];
              voiceMatchDone = false;
              const unlockedSpeakerId = lockedSpeakerId;
              lockedSpeakerId = null;
              // Reset candidate/accumulation state so matching starts fresh
              for (const k of Object.keys(candidateScores)) delete candidateScores[k];
              for (const k of Object.keys(candidateReadyAt)) delete candidateReadyAt[k];
              matchGraceDeadline = null;
              for (const k of Object.keys(speakerChunks)) delete speakerChunks[k];
              if (socket.readyState === 1) {
                socket.send(JSON.stringify({
                  type: 'speaker_unlock',
                  speakerId: `Speaker ${parseInt(unlockedSpeakerId, 10) + 1}`,
                  reason: 'drift_detected',
                }));
              }
            }
          }
        }
      }

      const isFinal = msg.is_final === true;

      if (isFinal) {
        // Split segment by speaker changes within the word list. Keep full
        // word objects (not just text) so we can compute word_count/duration_ms
        // per group for WPM analytics.
        const speakerGroups = [];
        let curSpeakerIdx = null;
        let curWords = [];
        for (const w of words) {
          const si = resolveSpeaker(w.speaker ?? rawSpeakerIdx);
          if (si !== curSpeakerIdx) {
            if (curWords.length > 0) speakerGroups.push({ si: curSpeakerIdx, words: curWords });
            curSpeakerIdx = si;
            curWords = [];
          }
          curWords.push(w);
        }
        if (curWords.length > 0) speakerGroups.push({ si: curSpeakerIdx, words: curWords });
        // Fallback: if no word-level data, use the full text as one group with
        // no timing info (word_count approximated, duration unknown).
        if (speakerGroups.length === 0) speakerGroups.push({ si: rawSpeakerIdx, words: null, fallbackText: text });

        let segmentCount = 0;
        for (const group of speakerGroups) {
          const groupText = group.words
            ? group.words.map(w => w.punctuated_word || w.word || '').join(' ').trim()
            : (group.fallbackText || '').trim();
          if (!groupText) continue;
          const si = String(group.si);

          // Word cadence data for WPM scoring — null duration when we don't
          // have real word timestamps (fallback path).
          let groupWordCount = null;
          let groupDurationMs = null;
          if (group.words && group.words.length > 0) {
            groupWordCount = group.words.length;
            const timedWords = group.words.filter(w => w.start !== undefined && w.end !== undefined);
            if (timedWords.length > 0) {
              const firstStart = timedWords[0].start;
              const lastEnd = timedWords[timedWords.length - 1].end;
              if (lastEnd > firstStart) groupDurationMs = Math.round((lastEnd - firstStart) * 1000);
            }
          } else {
            groupWordCount = groupText.split(/\s+/).filter(Boolean).length;
          }

          // Mid-call name introduction detection: lock an unlocked speaker to a
          // spoken name (e.g. "Hi, I'm John" / "This is Sarah"). Never overrides
          // an existing lock (voice-print or prior introduction).
          if (!speakerLocks[si]) {
            const introMatch = groupText.match(
              /\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Za-z][A-Za-z'-]{1,20})\b/i
            );
            if (introMatch) {
              const raw = introMatch[1];
              const STOPWORDS = new Set([
                'going', 'not', 'sure', 'here', 'ready', 'sorry', 'fine', 'good',
                'great', 'okay', 'ok', 'trying', 'looking', 'just', 'also', 'still',
                'actually', 'calling', 'gonna', 'kind', 'about', 'done', 'happy',
              ]);
              if (!STOPWORDS.has(raw.toLowerCase())) {
                const name = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
                speakerLocks[si] = name;
                fastify.log.info(`Name introduction detected: Speaker ${si} -> ${name}`);
                if (socket.readyState === 1) {
                  socket.send(JSON.stringify({
                    type: 'speaker_lock',
                    speakerId: `Speaker ${parseInt(si, 10) + 1}`,
                    name,
                  }));
                }
              }
            }
          }

          const groupLabel = speakerLocks[si] || `Speaker ${group.si + 1}`;
          try {
            await pool.query(
              `INSERT INTO transcript_segments (meeting_id, ts, speaker, text, word_count, duration_ms) VALUES ($1, NOW(), $2, $3, $4, $5)`,
              [meetingId, groupLabel, groupText, groupWordCount, groupDurationMs]
            );
          } catch (dbErr) {
            fastify.log.error('transcript_segments insert error:', dbErr);
          }
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'final', text: groupText, speaker: groupLabel }));
          }
        }
        // Get updated segment count for coaching trigger
        try {
          const countRes = await pool.query(
            `SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = $1`, [meetingId]
          );
          segmentCount = parseInt(countRes.rows[0].count, 10);
        } catch { /* ignore */ }
        if (segmentCount >= 3 && OPENROUTER_API_KEY) {
          runCoachingAnalysis(meetingId)
            .then(coaching => {
              if (coaching) broadcastToMeeting(meetingId, { type: 'coaching', data: coaching });
            })
            .catch(err => fastify.log.error('Auto-coaching error:', err.message));
        }
      } else {
        // Interim: use first speaker (splitting interims is too noisy)
        const interimLabel = speakerLocks[String(rawSpeakerIdx)] || `Speaker ${rawSpeakerIdx + 1}`;
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'interim', text, speaker: interimLabel }));
        }
      }
    });

    dgSocket.on('close', (code) => {
      dgReady = false;
      fastify.log.warn(`Deepgram closed (code=${code}) for meeting ${meetingId}`);
      if (!closed) {
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
      const totalBuffered = audioQueue.reduce((s, b) => s + b.byteLength, 0);
      if (totalBuffered < 960_000) audioQueue.push(Buffer.from(data));
    }
    // Feed the rolling audio ring buffer — always on, powers both rep
    // voiceprint matching and speaker de-duplication.
    const int16 = new Int16Array(data.buffer ?? data, data.byteOffset ?? 0, (data.byteLength ?? data.length) / 2);
    ringWrite(int16);
  });

  // ── Client disconnected ───────────────────────────────────────────────────

  socket.on('close', () => {
    fastify.log.info(`WS client disconnected: meeting ${meetingId}`);
    closed = true;
    unregisterMeetingSocket(meetingId, socket);
    if (reconnectTimer) clearTimeout(reconnectTimer);
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
