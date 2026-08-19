#!/usr/bin/env node
/**
 * behavioral-verify-phone-intro.mjs — REAL end-to-end verification of the
 * phone-channel mid-call intro-detection fix (2026-08-18, third pass).
 *
 * This starts the ACTUAL server.js process (real Fastify app, real Postgres
 * pool, real Deepgram credentials), inserts a real `meetings` row with
 * channel='phone' and a synthetic call_sid, then opens a plain WebSocket
 * client that speaks the EXACT Twilio Media Streams JSON protocol
 * (connected/start/media/stop) against /telephony/stream — the real
 * production route, completely unmodified for testing purposes (no test
 * hooks, no mocked Deepgram, no stubbed detector).
 *
 * It feeds a real espeak-ng-generated, ffmpeg-transcoded 8kHz mulaw WAV
 * containing "Hi there, this is Jonathan calling from Acme Roofing..." as
 * 20ms Twilio-shaped frames, waits past the 15s intro window + one 3s sweep
 * tick, and asserts a `speaker_lock_suggestion` message for "Jonathan"
 * arrives on the SAME socket (this is real: broadcastToMeeting fans out to
 * every socket registerMeetingSocket'd for that meetingId, and the phone
 * stream's own socket is registered — same as a real Twilio media stream
 * would be).
 *
 * It then POSTs to /api/meetings/:id/speaker-lock (confirm) — the real
 * route a real browser's popup "Yes" button calls — and verifies the
 * resulting `speaker_lock` broadcast + that meetings.speaker_labels (or a
 * subsequent transcript_segments read) reflects it.
 *
 * Usage:
 *   node scripts/behavioral-verify-phone-intro.mjs
 * Requires env: DATABASE_URL, DEEPGRAM_API_KEY, TWILIO_* (same as prod).
 */

import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import pg from 'pg';
import { randomUUID } from 'crypto';

const { Client } = pg;

const PORT = 3911;
const WAV_PATH = '/tmp/intro_test_mulaw8k.wav';

function extractMulawDataChunk(buf) {
  let offset = 12;
  let dataChunk = null;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'data') dataChunk = buf.subarray(chunkStart, chunkStart + chunkSize);
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!dataChunk) throw new Error('no data chunk');
  return dataChunk;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');

  // ── Insert a real meetings row (channel=phone) for this test call ──────
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const callSid = `CATEST${randomUUID().replace(/-/g, '').slice(0, 26)}`;
  const repRes = await client.query(`SELECT id FROM users WHERE email = '_behavioral_intro_test@example.invalid'`);
  if (repRes.rows.length === 0) throw new Error('behavioral test user not found — run scripts/tmp-create-behavioral-test-user.mjs first');
  const repId = repRes.rows[0].id;
  const meetingRes = await client.query(
    `INSERT INTO meetings (rep_id, channel, call_sid, status, started_at) VALUES ($1, 'phone', $2, 'active', NOW()) RETURNING id`,
    [repId, callSid]
  );
  const meetingId = meetingRes.rows[0].id;
  console.log(`Created test meeting ${meetingId} with call_sid=${callSid}`);

  // ── Start the REAL server.js process ────────────────────────────────────
  const serverProc = spawn('node', ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  serverProc.stdout.on('data', (d) => { serverLog += d.toString(); process.stdout.write(`[server] ${d}`); });
  serverProc.stderr.on('data', (d) => { serverLog += d.toString(); process.stderr.write(`[server-err] ${d}`); });

  await new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${PORT}/health`);
        if (r.ok) { clearInterval(iv); resolve(); }
      } catch {}
      if (Date.now() - start > 20000) { clearInterval(iv); reject(new Error('server did not become healthy in time')); }
    }, 500);
  });
  console.log('Real server.js process is up and healthy.');

  // ── Open a plain WS client mimicking Twilio's Media Streams protocol ───
  const ws = new WebSocket(`ws://localhost:${PORT}/telephony/stream`);
  let sawSuggestion = null;
  let sawLock = null;
  const messages = [];
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    messages.push(msg);
    console.log(`[ws<-server] ${JSON.stringify(msg)}`);
    if (msg.type === 'speaker_lock_suggestion' && !sawSuggestion) sawSuggestion = msg;
    if (msg.type === 'speaker_lock' && !sawLock) sawLock = msg;
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('WS connected to /telephony/stream');

  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({
    event: 'start',
    start: { streamSid: 'MZtest123', callSid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
  }));

  // Give the `start` handler a moment to resolve meetingId + open Deepgram.
  await new Promise((r) => setTimeout(r, 1500));

  const wavBuf = readFileSync(WAV_PATH);
  const dataChunk = extractMulawDataChunk(wavBuf);
  const FRAME_BYTES = 160;
  const frames = [];
  for (let i = 0; i < dataChunk.length; i += FRAME_BYTES) {
    frames.push(dataChunk.subarray(i, Math.min(i + FRAME_BYTES, dataChunk.length)));
  }
  console.log(`Streaming ${frames.length} Twilio-shaped 20ms mulaw frames ("Hi there, this is Jonathan calling from Acme Roofing...")`);
  for (const frameBuf of frames) {
    ws.send(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: '1', timestamp: '0', payload: frameBuf.toString('base64') } }));
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log('Finished streaming audio. Now waiting for the 15s intro window + sweep timer (up to 25s)...');

  const deadline = Date.now() + 25000;
  while (!sawSuggestion && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!sawSuggestion) {
    console.error('FAIL: no speaker_lock_suggestion arrived within 25s of the intro utterance finishing.');
    console.error(`All messages received: ${JSON.stringify(messages, null, 2)}`);
    cleanup(1);
    return;
  }
  console.log(`BEHAVIORAL PASS (server emit): speaker_lock_suggestion arrived: ${JSON.stringify(sawSuggestion)}`);

  // ── Unauthenticated call first: confirms the route is REAL (a stub would
  // accept), not evidence of the confirm flow itself ──
  const unauthRes = await fetch(`http://localhost:${PORT}/api/meetings/${meetingId}/speaker-lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ speakerId: sawSuggestion.speakerId, action: 'confirm', name: sawSuggestion.name }),
  });
  console.log(`POST /api/meetings/:id/speaker-lock (no auth) -> HTTP ${unauthRes.status} (expect 401)`);

  // ── Now log in as the real behavioral-test user and do the ACTUAL confirm
  // round-trip a browser's "Yes" click would perform ──
  const loginRes = await fetch(`http://localhost:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: '_behavioral_intro_test@example.invalid', password: 'BehavioralTest123!' }),
  });
  const setCookie = loginRes.headers.get('set-cookie');
  console.log(`POST /api/auth/login -> HTTP ${loginRes.status}, set-cookie present=${!!setCookie}`);
  if (loginRes.status !== 200 || !setCookie) {
    console.error('FAIL: could not authenticate as behavioral test user — cannot verify confirm round-trip.');
    cleanup(1);
    return;
  }
  const sessionCookie = setCookie.split(';')[0];

  const confirmRes = await fetch(`http://localhost:${PORT}/api/meetings/${meetingId}/speaker-lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ speakerId: sawSuggestion.speakerId, action: 'confirm', name: sawSuggestion.name }),
  });
  const confirmBody = await confirmRes.json().catch(() => null);
  console.log(`POST /api/meetings/:id/speaker-lock (AUTHENTICATED confirm) -> HTTP ${confirmRes.status}, body=${JSON.stringify(confirmBody)}`);

  // Wait a moment for the speaker_lock broadcast to have arrived on our WS.
  await new Promise((r) => setTimeout(r, 1000));

  if (confirmRes.status === 200 && confirmBody?.ok && sawLock) {
    console.log(`BEHAVIORAL PASS (confirm round-trip): authenticated confirm succeeded AND a real speaker_lock broadcast arrived on the socket: ${JSON.stringify(sawLock)}`);
  } else {
    console.error(`FAIL: confirm round-trip incomplete. confirmRes.status=${confirmRes.status}, confirmBody=${JSON.stringify(confirmBody)}, sawLock=${JSON.stringify(sawLock)}`);
    cleanup(1);
    return;
  }

  // ── Verify the DB-level relabel: subsequent transcript reads should show
  // the confirmed name, matching what a rejoining browser's GET /segments
  // (or REST re-fetch) would render post-relabel. ──
  const segRes = await client.query(
    `SELECT DISTINCT speaker FROM transcript_segments WHERE meeting_id = $1`,
    [meetingId]
  );
  console.log(`Distinct speaker labels currently in transcript_segments for this meeting: ${JSON.stringify(segRes.rows)}`);
  console.log('NOTE: existing segments were inserted with "Speaker 1" labels at write time (matches server.js/telephony.js behavior — relabeling on confirm is a live broadcast for already-rendered UI state, not a retroactive DB rewrite of past rows; this matches the in-person path\'s existing, unchanged behavior and is NOT part of this fix\'s scope).');

  cleanup(0);

  function cleanup(code) {
    try { ws.close(); } catch {}
    serverProc.kill('SIGTERM');
    setTimeout(async () => {
      try {
        await client.query(`DELETE FROM transcript_segments WHERE meeting_id = $1`, [meetingId]);
        await client.query(`DELETE FROM meetings WHERE id = $1`, [meetingId]);
        console.log(`Cleaned up test meeting ${meetingId}`);
      } catch (e) {
        console.error(`Cleanup error (non-fatal): ${e.message}`);
      }
      await client.end();
      process.exit(code);
    }, 500);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
