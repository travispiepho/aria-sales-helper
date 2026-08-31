import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import twilio from 'twilio';

// aria_browser_call_coaching_not_active_fix (2026-08-30)
//
// Root cause confirmed by investigation: the Twilio Media Stream WS handler
// (telephony.js's /telephony/stream, GET handler registered inside
// registerTelephonyRoutes()) is the SHARED transcript-ingestion path for
// BOTH Twilio-phone calls AND browser-originated calls (both are dialed via
// the same /telephony/browser-outgoing route's <Start><Stream
// url=".../telephony/stream"> TwiML — browser calls are not a separate
// ingestion path). That handler persisted transcript_segments and broadcast
// `final` transcript events, but NEVER called runCoachingAnalysis() at all
// — unlike the in-person /meetings/:id/audio WS handler (server.js) and the
// uploaded-recording WS handler (uploadedRecording.js), which both already
// have this trigger. This is failure mode #1 ("never triggers"), not a
// delivery or rendering bug — confirmed by reading every call site of
// runCoachingAnalysis() and finding telephony.js absent from that list
// prior to this fix.
//
// This test exercises a browser-call-SHAPED meeting (channel='phone' +
// call_sid, created via the exact same findOrCreatePhoneMeeting() row shape
// documented as shared by both Twilio-phone and browser-originated calls)
// through the real /telephony/stream handler with a fixture Deepgram
// session and a mocked runCoachingAnalysis, and asserts:
//   1. runCoachingAnalysis is invoked once segmentCount >= 3 (matching the
//      in-person/uploaded-recording trigger threshold), with the correct
//      meetingId.
//   2. Its resolved coaching payload is broadcast to the meeting as a
//      `{ type: 'coaching' }` message — the same shape/channel the frontend
//      already listens for (MeetingPage.tsx's shared WS message handler),
//      confirming the plumbing would reach the client.
//   3. A null/falsy coaching result is never broadcast (matches the
//      existing `if (coaching) broadcastToMeeting(...)` guard convention
//      used by every other coaching call site in this codebase).
//   4. Overlapping triggers do not stack concurrent LLM calls (in-flight
//      guard), mirroring uploadedRecording.js's `coachingInFlight` pattern.

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

const telephony = await import(`../telephony.js?coaching-trigger-test=${Date.now()}`);
const CALL_SID = 'CA66666666666666666666666666666666';
const MEETING_ID = 'meeting-browser-call-coaching-1';
const STREAM_URL = 'wss://aria.example.test/telephony/stream';

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
        return { rows: [{ name: 'Ada Rep', email: 'ada.rep@example.test' }] };
      }
      if (sql.includes('FROM objections o')) return { rows: [] };
      if (sql.includes('INSERT INTO transcript_segments')) {
        const row = { id: `segment-${segments.length + 1}`, meeting_id: params[0], speaker: params[1], text: params[2] };
        segments.push(row);
        return { rows: [row], rowCount: 1 };
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

async function buildApp({ coachingImpl } = {}) {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  app.decorateRequest('user', null);
  const pool = makePool();
  const state = { sessions: [], broadcasts: [], coachingCalls: [] };
  const runCoachingAnalysis = coachingImpl || (async (meetingId) => {
    state.coachingCalls.push(meetingId);
    return { disc: { detected: 'D' }, nudges: ['Confirm the visit time'], urgent: null };
  });
  await telephony.registerTelephonyRoutes(app, {
    pool,
    createTranscriptionSession: makeTranscriptionFactory(state),
    broadcastToMeeting: (meetingId, payload) => state.broadcasts.push({ meetingId, payload }),
    registerMeetingSocket: () => {},
    unregisterMeetingSocket: () => {},
    runCoachingAnalysis,
  });
  await app.ready();
  return { app, pool, state };
}

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

function startMessage() {
  return {
    event: 'start', sequenceNumber: '1', streamSid: 'MZ22222222222222222222222222222222',
    start: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      streamSid: 'MZ22222222222222222222222222222222', callSid: CALL_SID, tracks: ['inbound', 'outbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: {},
    },
  };
}

test('browser-call-shaped meeting on /telephony/stream triggers coaching at segment 3 and broadcasts it', async () => {
  const { app, state } = await buildApp();
  const ws = await app.injectWS('/telephony/stream', signedStreamUpgrade());
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify(startMessage()));
  await waitFor(() => state.sessions.length === 2);
  const [repSession, customerSession] = state.sessions;

  // Two segments: coaching must NOT fire yet (threshold is 3, matching the
  // in-person/uploaded-recording convention).
  repSession.emitTranscript({ isFinal: true, text: 'Hi there', speaker: 0, words: [] });
  customerSession.emitTranscript({ isFinal: true, text: 'Hello', speaker: 0, words: [] });
  await waitFor(() => state.broadcasts.filter(({ payload }) => payload.type === 'final').length === 2);
  assert.equal(state.coachingCalls.length, 0, 'coaching must not fire before 3 segments');

  // Third segment crosses the threshold.
  repSession.emitTranscript({ isFinal: true, text: 'Tell me about your project', speaker: 0, words: [] });
  await waitFor(() => state.coachingCalls.length === 1);
  assert.deepEqual(state.coachingCalls, [MEETING_ID]);

  await waitFor(() => state.broadcasts.some(({ payload }) => payload.type === 'coaching'));
  const coachingBroadcast = state.broadcasts.find(({ payload }) => payload.type === 'coaching');
  assert.equal(coachingBroadcast.meetingId, MEETING_ID);
  assert.deepEqual(coachingBroadcast.payload.data.nudges, ['Confirm the visit time']);

  ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '9', streamSid: 'MZ22222222222222222222222222222222', stop: { callSid: CALL_SID } }));
  ws.close();
  if (ws.readyState !== ws.CLOSED) await once(ws, 'close');
  await app.close();
});

test('a null/falsy coaching result is never broadcast', async () => {
  const { app, state } = await buildApp({ coachingImpl: async () => null });
  const ws = await app.injectWS('/telephony/stream', signedStreamUpgrade());
  ws.send(JSON.stringify(startMessage()));
  await waitFor(() => state.sessions.length === 2);
  const [repSession] = state.sessions;

  for (let i = 0; i < 3; i += 1) {
    repSession.emitTranscript({ isFinal: true, text: `Segment ${i}`, speaker: 0, words: [] });
  }
  await waitFor(() => state.broadcasts.filter(({ payload }) => payload.type === 'final').length === 3);
  // Give the fire-and-forget coaching promise a tick to resolve.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(state.broadcasts.some(({ payload }) => payload.type === 'coaching'), false);

  ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '9', streamSid: 'MZ22222222222222222222222222222222', stop: { callSid: CALL_SID } }));
  ws.close();
  if (ws.readyState !== ws.CLOSED) await once(ws, 'close');
  await app.close();
});

test('overlapping triggers do not stack concurrent coaching calls (in-flight guard)', async () => {
  let concurrentCalls = 0;
  let maxConcurrent = 0;
  let resolveFirst;
  const firstCallGate = new Promise((resolve) => { resolveFirst = resolve; });
  let callIndex = 0;
  const coachingImpl = async (meetingId) => {
    callIndex += 1;
    const myIndex = callIndex;
    concurrentCalls += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
    if (myIndex === 1) await firstCallGate;
    concurrentCalls -= 1;
    return { disc: { detected: 'D' }, nudges: [], urgent: null };
  };
  const { app, state } = await buildApp({ coachingImpl });
  const ws = await app.injectWS('/telephony/stream', signedStreamUpgrade());
  ws.send(JSON.stringify(startMessage()));
  await waitFor(() => state.sessions.length === 2);
  const [repSession] = state.sessions;

  // Cross the threshold, then immediately send more segments while the
  // first coaching call is still in flight (gated on firstCallGate).
  repSession.emitTranscript({ isFinal: true, text: 'One', speaker: 0, words: [] });
  repSession.emitTranscript({ isFinal: true, text: 'Two', speaker: 0, words: [] });
  repSession.emitTranscript({ isFinal: true, text: 'Three', speaker: 0, words: [] });
  await waitFor(() => callIndex >= 1);
  repSession.emitTranscript({ isFinal: true, text: 'Four', speaker: 0, words: [] });
  repSession.emitTranscript({ isFinal: true, text: 'Five', speaker: 0, words: [] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(maxConcurrent, 1, 'no two coaching calls should run concurrently for the same call');

  resolveFirst();
  await waitFor(() => concurrentCalls === 0);

  ws.send(JSON.stringify({ event: 'stop', sequenceNumber: '9', streamSid: 'MZ22222222222222222222222222222222', stop: { callSid: CALL_SID } }));
  ws.close();
  if (ws.readyState !== ws.CLOSED) await once(ws, 'close');
  await app.close();
});

process.on('exit', () => { process.env = ORIGINAL_ENV; });
