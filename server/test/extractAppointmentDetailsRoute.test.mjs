/**
 * extractAppointmentDetailsRoute.test.mjs — aria_setup_call_extract_appointment_button
 *
 * REAL end-to-end verification against the ACTUAL server.js process, same
 * pattern as setupCallCoachingIntegration.test.mjs (real Fastify app, real
 * Postgres pool, real OpenRouter call). Covers:
 *   (a) a phone/call_sid setup-call meeting: the route runs, returns
 *       structured appointment details, and persists them to
 *       setup_call_project_info (readable via GET /api/meetings/:id).
 *   (b) an in-person meeting is correctly rejected (400) — this route is
 *       setup-call-only.
 *   (c) auth: unauthenticated (401) and a different rep's meeting (403).
 *
 * Requires DATABASE_URL + OPENROUTER_API_KEY in the environment. Skips
 * gracefully (does not fail) when they are not set, matching this repo's
 * test-suite-must-run-clean convention for its other behavioral-verify /
 * live-integration tests.
 *
 * Run standalone:
 *   DATABASE_URL=... OPENROUTER_API_KEY=... node --test test/extractAppointmentDetailsRoute.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'child_process';
import pg from 'pg';

const { Client } = pg;

const HAS_LIVE_CREDS = !!process.env.DATABASE_URL && !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY);
const PORT = 3914;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = '_extract_appt_details_test@example.invalid';
const TEST_EMAIL_2 = '_extract_appt_details_test2@example.invalid';
const TEST_PASSWORD = 'behavioral-test-pw-12345';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

async function ensureUser(client, email) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const bcrypt = await import('bcryptjs');
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const res = await client.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'rep') RETURNING id`,
    ['ExtractApptTestRep', email, hash]
  );
  return res.rows[0].id;
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.ok, true, `login failed for ${email}: ${res.status} ${JSON.stringify(body)}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /session_id=([^;]+)/.exec(setCookie);
  const sessionCookie = match ? match[1] : body.sessionId;
  return { Cookie: `session_id=${sessionCookie}` };
}

test('POST /api/meetings/:id/extract-appointment-details: setup-call happy path, in-person rejection, auth matrix', {
  skip: !HAS_LIVE_CREDS && 'DATABASE_URL/OPENROUTER_API_KEY not set — skipping live integration test',
}, async (t) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const repId = await ensureUser(client, TEST_EMAIL);
  await ensureUser(client, TEST_EMAIL_2);

  let serverProc;
  const meetingIds = [];

  t.after(async () => {
    for (const id of meetingIds) {
      try {
        await client.query('DELETE FROM setup_call_project_info WHERE meeting_id = $1', [id]);
        await client.query('DELETE FROM coaching_snapshots WHERE meeting_id = $1', [id]);
        await client.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [id]);
        await client.query('DELETE FROM meetings WHERE id = $1', [id]);
      } catch (err) {
        console.error(`cleanup failed for meeting ${id}:`, err.message);
      }
    }
    if (serverProc) {
      serverProc.kill();
      await sleep(500);
    }
    await client.end();
  });

  serverProc = spawn('node', ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => { serverLog += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverLog += d.toString(); });

  const ready = await waitForHealth();
  if (!ready) {
    console.error('Server log:\n', serverLog);
    assert.fail('server.js did not become ready in time');
  }

  const cookieHeader = await login(TEST_EMAIL);
  const otherRepCookieHeader = await login(TEST_EMAIL_2);

  // ── (a) Setup-call phone meeting: full happy path ──
  const phoneMeetingRes = await fetch(`${BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeader },
    body: JSON.stringify({ channel: 'phone' }),
  });
  assert.equal(phoneMeetingRes.ok, true);
  const phoneMeeting = await phoneMeetingRes.json();
  meetingIds.push(phoneMeeting.id);
  await client.query(`UPDATE meetings SET call_sid = $1 WHERE id = $2`, [`CA_test_${phoneMeeting.id}`, phoneMeeting.id]);

  const transcript = [
    ['Rep', 'Hi, this is Alex from CertaPro, is this Jane?'],
    ['Customer', 'Yes, I need my exterior repainted, house is about 2000 sqft.'],
    ['Rep', 'Got it. One more thing before we hang up — does Thursday at 2pm work for me to swing by?'],
    ['Customer', 'Yes, Thursday at 2pm works, address is 456 Oak St.'],
  ];
  for (const [speaker, text] of transcript) {
    await client.query(
      `INSERT INTO transcript_segments (meeting_id, ts, speaker, text) VALUES ($1, NOW(), $2, $3)`,
      [phoneMeeting.id, speaker, text]
    );
  }

  const extractRes = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}/extract-appointment-details`, {
    method: 'POST',
    headers: cookieHeader,
  });
  const extractBody = await extractRes.json();
  assert.equal(extractRes.ok, true, `extraction failed: ${extractRes.status} ${JSON.stringify(extractBody)}`);
  assert.equal(extractBody.mode, 'appointment_extraction');
  assert.ok(extractBody.project_info, 'expected project_info in response');
  assert.equal(typeof extractBody.project_info.appointment_set, 'boolean');
  assert.equal(extractBody.project_info.appointment_set, true, 'transcript explicitly booked Thursday 2pm');

  // Persisted: readable back via GET /api/meetings/:id.
  const refetch = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}`, { headers: cookieHeader });
  const refetched = await refetch.json();
  assert.equal(refetched.is_setup_call_mode, true);
  assert.deepEqual(refetched.setup_call_project_info, extractBody.project_info, 'extraction result must be persisted to setup_call_project_info');

  // ── (b) In-person meeting: must be rejected, not just silently no-op ──
  const inPersonMeetingRes = await fetch(`${BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeader },
    body: JSON.stringify({ channel: 'in_person' }),
  });
  const inPersonMeeting = await inPersonMeetingRes.json();
  meetingIds.push(inPersonMeeting.id);

  const inPersonExtractRes = await fetch(`${BASE}/api/meetings/${inPersonMeeting.id}/extract-appointment-details`, {
    method: 'POST',
    headers: cookieHeader,
  });
  assert.equal(inPersonExtractRes.status, 400, 'in-person meeting must be rejected as not a setup call');

  // ── (c) Auth matrix ──
  const unauthRes = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}/extract-appointment-details`, { method: 'POST' });
  assert.equal(unauthRes.status, 401, 'unauthenticated request must be rejected');

  const otherRepRes = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}/extract-appointment-details`, {
    method: 'POST',
    headers: otherRepCookieHeader,
  });
  assert.equal(otherRepRes.status, 403, 'a different rep must not be able to extract another rep\'s meeting');

  // 404 for a nonexistent meeting id.
  const notFoundRes = await fetch(`${BASE}/api/meetings/00000000-0000-0000-0000-000000000000/extract-appointment-details`, {
    method: 'POST',
    headers: cookieHeader,
  });
  assert.equal(notFoundRes.status, 404);
});
