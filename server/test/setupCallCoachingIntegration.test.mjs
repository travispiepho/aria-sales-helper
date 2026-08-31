/**
 * setupCallCoachingIntegration.test.mjs — aria_setup_call_coaching_differentiation
 *
 * REAL end-to-end verification against the ACTUAL server.js process (real
 * Fastify app, real Postgres pool, real OpenRouter call), same pattern as
 * scripts/behavioral-verify-rebuttal-teleprompter.mjs. Covers the three
 * scenarios the task brief calls out explicitly:
 *   (a) a phone/call_sid meeting gets setup-call-mode coaching output
 *       instead of stage/checklist
 *   (b) an in-person meeting is unaffected (regression)
 *   (c) persisted project-info survives a re-fetch of the meeting
 *
 * Requires DATABASE_URL + OPENROUTER_API_KEY in the environment (same live
 * credentials this repo's other behavioral-verify-*.mjs scripts require).
 * Skips gracefully (does not fail) when they are not set, so `npm test` /
 * `node --test` stays green in an environment with no live credentials —
 * matching this repo's test-suite-must-run-clean convention. When it DOES
 * run, this is also the live-verification evidence this task's brief
 * requires.
 *
 * Run standalone:
 *   DATABASE_URL=... OPENROUTER_API_KEY=... node --test test/setupCallCoachingIntegration.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'child_process';
import pg from 'pg';

const { Client } = pg;

const HAS_LIVE_CREDS = !!process.env.DATABASE_URL && !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY);
const PORT = 3913;
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = '_setup_call_coaching_test@example.invalid';
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

test('aria_setup_call_coaching_differentiation: setup-call phone meeting gets setup_call mode, in-person unaffected, project_info survives re-fetch', { skip: !HAS_LIVE_CREDS && 'DATABASE_URL/OPENROUTER_API_KEY not set — skipping live behavioral test' }, async (t) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // ── Test user (reusable across runs, same convention as this repo's
  // other behavioral-verify-*.mjs scripts) ──
  let repId;
  const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [TEST_EMAIL]);
  if (existingUser.rows.length > 0) {
    repId = existingUser.rows[0].id;
  } else {
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    const res = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'rep') RETURNING id`,
      ['SetupCallTestRep', TEST_EMAIL, hash]
    );
    repId = res.rows[0].id;
  }

  let serverProc;
  const phoneMeetingIds = [];
  const inPersonMeetingIds = [];

  // Single consolidated cleanup hook (registered ONCE, LAST-registered-
  // hook-runs-first semantics don't matter here since there is only one) —
  // deletes all fixture rows THEN kills the server process THEN closes the
  // DB client, in that order, so no cleanup step runs against an
  // already-closed connection.
  t.after(async () => {
    for (const id of [...phoneMeetingIds, ...inPersonMeetingIds]) {
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

  // ── Log in for real ──
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.ok, true, `login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionCookieMatch = /session_id=([^;]+)/.exec(setCookie);
  const sessionCookie = sessionCookieMatch ? sessionCookieMatch[1] : loginBody.sessionId;
  const cookieHeader = { Cookie: `session_id=${sessionCookie}` };

  // ── (a) Setup-call phone meeting: create via API (channel='phone'), then
  // stamp a call_sid directly via DB — mirrors what
  // telephony.js's findOrCreatePhoneMeeting() does for a REAL Twilio/browser
  // call; there is no public API surface that sets call_sid directly (by
  // design — it's server-assigned from the Twilio webhook), so a direct DB
  // write is the correct way to construct this fixture. ──
  const phoneMeetingRes = await fetch(`${BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeader },
    body: JSON.stringify({ channel: 'phone' }),
  });
  assert.equal(phoneMeetingRes.ok, true);
  const phoneMeeting = await phoneMeetingRes.json();
  phoneMeetingIds.push(phoneMeeting.id);
  await client.query(`UPDATE meetings SET call_sid = $1 WHERE id = $2`, [`CA_test_${phoneMeeting.id}`, phoneMeeting.id]);

  const setupCallTranscript = [
    ['Rep', 'Hi, this is Alex calling from CertaPro Painters, is this Jane?'],
    ['Customer', 'Yes, speaking. I need my house exterior repainted, it is peeling pretty badly.'],
    ['Rep', 'Got it. Do you have a rough idea of the square footage or is it a two-story home?'],
    ['Customer', 'It is about a 2000 square foot two-story, and we would like it done before winter if possible.'],
    ['Rep', 'That works. Would Thursday at 2pm work for me to come out and take a look in person?'],
    ['Customer', 'Yes, Thursday at 2pm is great.'],
  ];
  for (const [speaker, text] of setupCallTranscript) {
    await client.query(
      `INSERT INTO transcript_segments (meeting_id, ts, speaker, text) VALUES ($1, NOW(), $2, $3)`,
      [phoneMeeting.id, speaker, text]
    );
  }

  const phoneCoachingRes = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}/coaching`, {
    method: 'POST',
    headers: cookieHeader,
  });
  const phoneCoaching = await phoneCoachingRes.json();
  assert.equal(phoneCoachingRes.ok, true, `coaching trigger failed: ${phoneCoachingRes.status} ${JSON.stringify(phoneCoaching)}`);

  // (a) Assertion: setup-call mode shape, NOT the 11-step stage/checklist.
  assert.equal(phoneCoaching.mode, 'setup_call', `expected setup_call mode, got: ${JSON.stringify(phoneCoaching)}`);
  assert.equal('stage' in phoneCoaching, false, 'setup-call coaching must not include stage');
  assert.equal('checklist' in phoneCoaching, false, 'setup-call coaching must not include checklist');
  assert.ok(phoneCoaching.project_info, 'expected project_info in setup-call coaching output');
  assert.equal(typeof phoneCoaching.project_info.appointment_set, 'boolean');

  // ── (b) In-person meeting: regression check, must be COMPLETELY
  // unaffected — still gets the 11-step stage/checklist coaching. ──
  const inPersonMeetingRes = await fetch(`${BASE}/api/meetings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeader },
    body: JSON.stringify({ channel: 'in_person' }),
  });
  assert.equal(inPersonMeetingRes.ok, true);
  const inPersonMeeting = await inPersonMeetingRes.json();
  inPersonMeetingIds.push(inPersonMeeting.id);

  const inPersonTranscript = [
    ['Rep', 'Thanks for having me out today, tell me a bit about the family and what you all like to do.'],
    ['Customer', 'We love hiking on the weekends, been in this house about ten years.'],
    ['Rep', 'Nice. So walking around the exterior, what areas are you most concerned about?'],
  ];
  for (const [speaker, text] of inPersonTranscript) {
    await client.query(
      `INSERT INTO transcript_segments (meeting_id, ts, speaker, text) VALUES ($1, NOW(), $2, $3)`,
      [inPersonMeeting.id, speaker, text]
    );
  }

  const inPersonCoachingRes = await fetch(`${BASE}/api/meetings/${inPersonMeeting.id}/coaching`, {
    method: 'POST',
    headers: cookieHeader,
  });
  const inPersonCoaching = await inPersonCoachingRes.json();
  assert.equal(inPersonCoachingRes.ok, true, `coaching trigger failed: ${inPersonCoachingRes.status} ${JSON.stringify(inPersonCoaching)}`);

  assert.notEqual(inPersonCoaching.mode, 'setup_call', 'in-person meeting must not get setup_call mode');
  assert.ok(inPersonCoaching.stage, 'in-person coaching must still include stage');
  assert.ok(Array.isArray(inPersonCoaching.checklist), 'in-person coaching must still include checklist array');
  assert.equal('project_info' in inPersonCoaching, false, 'in-person coaching must not include project_info');

  // ── (c) Persisted project-info survives a re-fetch of the meeting ──
  const refetch1 = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}`, { headers: cookieHeader });
  assert.equal(refetch1.ok, true);
  const refetched1 = await refetch1.json();
  assert.equal(refetched1.is_setup_call_mode, true);
  assert.ok(refetched1.setup_call_project_info, 'expected setup_call_project_info on GET /api/meetings/:id re-fetch');
  assert.equal(refetched1.setup_call_project_info.appointment_set, true, 'appointment_set should be true given the transcript booked Thursday 2pm');

  // Second re-fetch (no new coaching run in between) — must still be there,
  // proving this is real DB persistence, not something only alive in the
  // just-computed response.
  const refetch2 = await fetch(`${BASE}/api/meetings/${phoneMeeting.id}`, { headers: cookieHeader });
  const refetched2 = await refetch2.json();
  assert.deepEqual(refetched2.setup_call_project_info, refetched1.setup_call_project_info, 'project_info must be stable across repeated re-fetches');

  // In-person meeting must NOT expose setup_call_project_info / is_setup_call_mode=true.
  const inPersonRefetch = await fetch(`${BASE}/api/meetings/${inPersonMeeting.id}`, { headers: cookieHeader });
  const inPersonRefetched = await inPersonRefetch.json();
  assert.equal(inPersonRefetched.is_setup_call_mode, false);
  assert.equal('setup_call_project_info' in inPersonRefetched, false);
});
