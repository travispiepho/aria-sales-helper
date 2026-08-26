import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import twilio from 'twilio';

const ORIGINAL_ENV = { ...process.env };
Object.assign(process.env, {
  DEEPGRAM_API_KEY: 'fixture_deepgram_key',
  TWILIO_ACCOUNT_SID: 'AC11111111111111111111111111111111',
  TWILIO_API_KEY_SID: 'SK22222222222222222222222222222222',
  TWILIO_API_KEY_SECRET: 'test_secret',
  TWILIO_AUTH_TOKEN: 'test_auth_token',
  TWILIO_PHONE_NUMBER: '+16165550100',
  TWILIO_TWIML_APP_SID: 'AP33333333333333333333333333333333',
});

const telephony = await import(`../telephony.js?rep-phone-test=${Date.now()}`);
const CALL_SID = 'CA55555555555555555555555555555555';
const MEETING_ID = 'meeting-rep-phone-1';
const REP_ID = 'rep-account-1';
const REP_NAME = 'Ada Rep';
const STREAM_URL = 'https://aria.example.test/telephony/stream';

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for fixture condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makePool() {
  const segments = [];
  return {
    segments,
    async query(sql, params = []) {
      if (sql.includes('SELECT id FROM meetings WHERE call_sid')) {
        return { rows: params[0] === CALL_SID ? [{ id: MEETING_ID }] : [] };
      }
      if (sql.includes('SELECT u.name, u.email')) {
        assert.equal(params[0], MEETING_ID);
        return { rows: [{ name: REP_NAME, email: 'ada.rep@example.test' }] };
      }
      if (sql.includes('FROM objections o')) return { rows: [] };
      if (sql.includes('INSERT INTO transcript_segments')) {
        const row = { id: `segment-${segments.length + 1}`, meeting_id: params[0], speaker: params[1], text: params[2] };
        segments.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('SELECT id, speaker, text, ts FROM transcript_segments')) {
        return { rows: segments.filter((row) => row.meeting_id === params[0]) };
      }
      throw new Error(`Unhandled SQL in fixture: ${sql}`);
    },
  };
}

function makeTranscriptionFactory(state) {
  return ({ onTranscript, ...options }) => {
    const session = {
      options,
      sent: [],
      closed: false,
      send(buf) { this.sent.push(Buffer.from(buf)); },
      close() { this.closed = true; },
      emitTranscript(result) { onTranscript(result); },
    };
    state.sessions.push(session);
    return session;
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  app.decorateRequest('user', null);
  const pool = makePool();
  const state = { sessions: [], broadcasts: [], registered: [], unregistered: [] };
  await telephony.registerTelephonyRoutes(app, {
    pool,
    createTranscriptionSession: makeTranscriptionFactory(state),
    broadcastToMeeting: (meetingId, payload) => state.broadcasts.push({ meetingId, payload }),
    registerMeetingSocket: (meetingId) => state.registered.push(meetingId),
    unregisterMeetingSocket: (meetingId) => state.unregistered.push(meetingId),
  });
  await app.ready();
  return { app, pool, state };
}

function signedHeaders(url, params) {
  return {
    host: new URL(url).host,
    'x-forwarded-proto': 'https',
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params),
  };
}

function form(params) { return new URLSearchParams(params).toString(); }

function signedStreamUpgrade(signatureUrl = STREAM_URL) {
  return {
    headers: {
      host: 'internal.railway:3000',
      'x-forwarded-host': 'aria.example.test',
      'x-forwarded-proto': 'https',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, signatureUrl, {}),
    },
  };
}

function startMessage(tracks = ['inbound', 'outbound']) {
  return {
    event: 'start', sequenceNumber: '1', streamSid: 'MZ11111111111111111111111111111111',
    start: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      streamSid: 'MZ11111111111111111111111111111111', callSid: CALL_SID, tracks,
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: {},
    },
  };
}

function mediaMessage(track, mulawByte) {
  return {
    event: 'media', sequenceNumber: '2', streamSid: 'MZ11111111111111111111111111111111',
    media: { track, chunk: '1', timestamp: '0', payload: Buffer.alloc(160, mulawByte).toString('base64') },
  };
}

async function postSigned(app, route, params, query = '') {
  const url = `https://aria.example.test${route}${query}`;
  return app.inject({ method: 'POST', url: `${route}${query}`, payload: form(params), headers: signedHeaders(url, params) });
}

test('rep-phone TwiML explicitly requests both tracks while preserving consent whisper and dual recording', async () => {
  const { app } = await buildApp();
  const params = { CallSid: CALL_SID, From: '+16165550111', To: '+16165550100' };
  const query = '?customer=%2B16165550123';
  const res = await postSigned(app, '/telephony/outbound-answer', params, query);
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /<Stream[^>]+url="wss:\/\/aria\.example\.test\/telephony\/stream"[^>]+track="both_tracks"/);
  assert.match(res.body, /record="record-from-answer-dual"/);
  assert.match(res.body, /recordingStatusCallback="https:\/\/aria\.example\.test\/telephony\/recording-status"/);
  assert.match(res.body, /<Number url="https:\/\/aria\.example\.test\/telephony\/consent-whisper">\+16165550123<\/Number>/);
  assert.ok(res.body.indexOf('<Stream') < res.body.indexOf('<Dial'));
  await app.close();
});

test('rep-phone TwiML fails closed on a bad signature', async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: 'POST', url: '/telephony/outbound-answer?customer=%2B16165550123',
    payload: form({ CallSid: CALL_SID }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bad' },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('signed dual-track fixture routes distinct mu-law audio independently and persists/emits deterministic labels', async () => {
  const { app, pool, state } = await buildApp();
  const ws = await app.injectWS('/telephony/stream', signedStreamUpgrade());
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify(startMessage()));
  await waitFor(() => state.sessions.length === 2);

  const [repSession, customerSession] = state.sessions;
  ws.send(JSON.stringify(mediaMessage('inbound', 0xff)));
  ws.send(JSON.stringify(mediaMessage('outbound', 0x55)));
  ws.send(JSON.stringify(mediaMessage(undefined, 0x00))); // no guessed routing or duplicate audio
  await waitFor(() => repSession.sent.length === 1 && customerSession.sent.length === 1);
  assert.notDeepEqual(repSession.sent[0], customerSession.sent[0]);

  repSession.emitTranscript({ isFinal: false, text: 'Rep interim', speaker: 0, words: [] });
  customerSession.emitTranscript({ isFinal: false, text: 'Customer interim', speaker: 0, words: [] });
  repSession.emitTranscript({ isFinal: true, text: 'Rep final', speaker: 0, words: [{ start: 0, end: 0.2 }] });
  customerSession.emitTranscript({ isFinal: true, text: 'Customer final', speaker: 0, words: [{ start: 0, end: 0.3 }] });
  await waitFor(() => pool.segments.length === 2 && state.broadcasts.filter(({ payload }) => payload.type === 'final').length === 2);

  assert.deepEqual(pool.segments.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: REP_NAME, text: 'Rep final' },
    { speaker: 'Customer', text: 'Customer final' },
  ]);
  // This is the same read model used by GET /api/meetings/:id/segments,
  // transcript downloads, and exports after refresh: persisted rows retain
  // the exact live labels.
  const readback = await pool.query(
    'SELECT id, speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC',
    [MEETING_ID],
  );
  assert.deepEqual(readback.rows.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: REP_NAME, text: 'Rep final' },
    { speaker: 'Customer', text: 'Customer final' },
  ]);
  const transcriptEvents = state.broadcasts
    .filter(({ payload }) => payload.type === 'interim' || payload.type === 'final')
    .map(({ payload }) => ({ type: payload.type, speaker: payload.speaker, text: payload.text }));
  assert.deepEqual(transcriptEvents, [
    { type: 'interim', speaker: REP_NAME, text: 'Rep interim' },
    { type: 'interim', speaker: 'Customer', text: 'Customer interim' },
    { type: 'final', speaker: REP_NAME, text: 'Rep final' },
    { type: 'final', speaker: 'Customer', text: 'Customer final' },
  ]);

  ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '5', streamSid: 'MZ11111111111111111111111111111111', stop: { callSid: CALL_SID } }));
  await waitFor(() => repSession.closed && customerSession.closed);
  ws.close();
  if (ws.readyState !== ws.CLOSED) await once(ws, 'close');
  assert.deepEqual(state.registered, [MEETING_ID]);
  assert.ok(state.unregistered.includes(MEETING_ID));
  await app.close();
});

test('Media Stream rejects missing/tampered signatures before opening STT sessions', async () => {
  const { app, state } = await buildApp();
  await assert.rejects(app.injectWS('/telephony/stream'), /Unexpected server response: 403/);
  await assert.rejects(app.injectWS('/telephony/stream', signedStreamUpgrade('https://evil.example/telephony/stream')), /Unexpected server response: 403/);
  assert.equal(state.sessions.length, 0);
  await app.close();
});

test('legacy inbound-only fallback remains one session and does not invent a customer stream', async () => {
  const { app, state } = await buildApp();
  const ws = await app.injectWS('/telephony/stream', signedStreamUpgrade());
  ws.send(JSON.stringify(startMessage(['inbound'])));
  await waitFor(() => state.sessions.length === 1);
  ws.send(JSON.stringify(mediaMessage('inbound', 0xff)));
  await waitFor(() => state.sessions[0].sent.length === 1);
  state.sessions[0].emitTranscript({ isFinal: true, text: 'Legacy line', speaker: 0, words: [] });
  await waitFor(() => state.broadcasts.some(({ payload }) => payload.type === 'final'));
  assert.equal(state.broadcasts.find(({ payload }) => payload.type === 'final').payload.speaker, 'Speaker 1');
  ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '5', streamSid: 'MZ11111111111111111111111111111111', stop: { callSid: CALL_SID } }));
  await waitFor(() => state.sessions[0].closed);
  ws.close();
  if (ws.readyState !== ws.CLOSED) await once(ws, 'close');
  assert.equal(state.sessions[0].closed, true);
  await app.close();
});

test('account rep label uses saved name, then saved account email, then conservative generic fallback', () => {
  assert.equal(telephony.accountRepLabel('  Ada Rep  ', 'ada@example.test'), 'Ada Rep');
  assert.equal(telephony.accountRepLabel(' ', ' ada@example.test '), 'ada@example.test');
  assert.equal(telephony.accountRepLabel(null, null), 'Rep');
  assert.notEqual(telephony.accountRepLabel(null, null), 'Customer');
});

process.on('exit', () => { process.env = ORIGINAL_ENV; });
