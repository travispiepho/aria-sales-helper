import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocketPlugin from '@fastify/websocket';
import {
  createUploadedRecordingProtocol,
  registerUploadedRecordingRoutes,
  UPLOADED_RECORDING_CHANNEL,
} from '../uploadedRecording.js';

const REP_ID = 'rep-1';
const OTHER_ID = 'rep-2';
const SESSION_ID = 'session-owner';
const MEETING_ID = 'meeting-upload-1';

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makePool() {
  const meetings = [];
  const segments = [];
  const sqlLog = [];
  return {
    meetings, segments, sqlLog,
    async query(sql, params = []) {
      sqlLog.push(sql);
      if (sql.includes('INSERT INTO meetings')) {
        const row = {
          id: MEETING_ID, customer_id: params[0], rep_id: params[1], status: 'active',
          owner_session_id: params[2], origin_client: 'web', channel: params[3], summary: null,
        };
        meetings.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql === 'SELECT * FROM meetings WHERE id = $1') {
        return { rows: meetings.filter((m) => m.id === params[0]) };
      }
      if (sql.includes('INSERT INTO transcript_segments')) {
        const row = { id: `segment-${segments.length + 1}`, ts: new Date(), meeting_id: params[0], speaker: params[1], text: params[2] };
        segments.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("UPDATE meetings SET status = 'interrupted'")) {
        const meeting = meetings.find((m) => m.id === params[0] && m.status === 'active');
        if (meeting) meeting.status = 'interrupted';
        return { rows: [], rowCount: meeting ? 1 : 0 };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
}

function makeTranscriptionFactory(state) {
  return ({ onTranscript }) => {
    const session = {
      sent: [], closed: false,
      send(buffer) { this.sent.push(Buffer.from(buffer)); },
      close() { this.closed = true; },
      emit(result) { onTranscript(result); },
    };
    state.sessions.push(session);
    return session;
  };
}

async function buildApp({ authenticated = true, wsUserId = REP_ID, wsSessionId = SESSION_ID, apiKey = 'dg-key' } = {}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(websocketPlugin);
  app.decorateRequest('user', null);
  const pool = makePool();
  const state = { sessions: [], broadcasts: [], completed: [], registered: [], unregistered: [], coachingCalls: 0 };
  await registerUploadedRecordingRoutes(app, {
    pool,
    apiKey,
    requireAuth: async (request, reply) => {
      if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' });
      request.user = { id: REP_ID, role: 'rep', name: 'Ada' };
    },
    authWebSocketWithSession: async () => ({
      user: authenticated ? { id: wsUserId, role: 'rep', name: 'Ada' } : null,
      sessionId: authenticated ? wsSessionId : null,
    }),
    createTranscriptionSession: makeTranscriptionFactory(state),
    broadcastToMeeting: (meetingId, payload) => state.broadcasts.push({ meetingId, payload }),
    registerMeetingSocket: (meetingId) => state.registered.push(meetingId),
    unregisterMeetingSocket: (meetingId) => state.unregistered.push(meetingId),
    runCoachingAnalysis: async () => {
      state.coachingCalls += 1;
      return { stage: { current: 'proposal' } };
    },
    finalizeMeeting: async (meetingId) => {
      const meeting = pool.meetings.find((m) => m.id === meetingId);
      assert.equal(meeting.status, 'active');
      meeting.status = 'completed';
      meeting.summary = 'Synthetic summary';
      state.completed.push(meetingId);
      return { summary: meeting.summary };
    },
    transcriptDrainMs: 0,
  });
  await app.ready();
  return { app, pool, state };
}

async function createMeeting(app, durationSeconds = 2) {
  const response = await app.inject({
    method: 'POST', url: '/api/uploaded-recordings',
    headers: { cookie: `session_id=${SESSION_ID}` },
    payload: { durationSeconds },
  });
  return response;
}

function start(durationSeconds = 2) {
  return JSON.stringify({ type: 'start', encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, playbackRate: 1, durationSeconds });
}

async function closeWs(ws) {
  if (ws.readyState === ws.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

test('protocol enforces ordering, bounded frames, 1x metadata, pause/resume, post-end and duplicate completion', () => {
  let now = 1_000;
  const protocol = createUploadedRecordingProtocol({ now: () => now });
  assert.throws(() => protocol.handleBinary(Buffer.alloc(2)), /start metadata/);
  assert.throws(() => protocol.handleControl('{'), /Malformed JSON/);
  assert.throws(() => protocol.handleControl(JSON.stringify({ type: 'start', encoding: 'wav', sampleRate: 16000, channels: 1, playbackRate: 1, durationSeconds: 2 })), /pcm_s16le/);
  assert.deepEqual(protocol.handleControl(start()), { type: 'started' });
  assert.throws(() => protocol.handleControl(start()), /Duplicate/);
  assert.throws(() => protocol.handleBinary(Buffer.alloc(65_536 + 2)), /64 KiB/);
  protocol.handleBinary(Buffer.alloc(32_000));
  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'pause' })), { type: 'paused' });
  assert.throws(() => protocol.handleBinary(Buffer.alloc(2)), /paused/);
  now += 5_000;
  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'resume' })), { type: 'resumed' });
  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'end' })), { type: 'ended', receivedBytes: 32_000 });
  assert.throws(() => protocol.handleBinary(Buffer.alloc(2)), /after end/);
  assert.throws(() => protocol.handleControl(JSON.stringify({ type: 'end' })), /already ended/);
});

test('protocol rejects declared-duration overflow and faster-than-real-time unbounded bursts', () => {
  let now = 0;
  const paced = createUploadedRecordingProtocol({ now: () => now });
  paced.handleControl(start(10));
  paced.handleBinary(Buffer.alloc(64_000));
  assert.throws(() => paced.handleBinary(Buffer.alloc(64_000)), /faster than real-time/);

  let boundedNow = 0;
  const bounded = createUploadedRecordingProtocol({ now: () => boundedNow });
  bounded.handleControl(start(1));
  boundedNow = 999_999;
  bounded.handleBinary(Buffer.alloc(64_000)); // declared bytes plus part of one max transport chunk
  bounded.handleBinary(Buffer.alloc(32_000));
  assert.throws(() => bounded.handleBinary(Buffer.alloc(2_002)), /declared duration/);
});

test('creation is authenticated and emits explicit uploaded_recording type without source-audio fields', async () => {
  const { app, pool } = await buildApp({ authenticated: false });
  const denied = await createMeeting(app);
  assert.equal(denied.statusCode, 401);
  assert.equal(pool.meetings.length, 0);
  await app.close();

  const built = await buildApp();
  const response = await createMeeting(built.app);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().channel, UPLOADED_RECORDING_CHANNEL);
  assert.equal(response.json().meeting_type, UPLOADED_RECORDING_CHANNEL);
  assert.equal(response.json().upload_protocol.playbackRate, 1);
  assert.ok(built.pool.sqlLog.every((sql) => !/audio|recording_(?:data|blob|path|url)|s3/i.test(sql.replaceAll('uploaded-recording', '').replaceAll('uploaded_recordings', ''))));
  assert.deepEqual(Object.keys(built.pool.meetings[0]).filter((key) => /audio|file|blob|path|url/i.test(key)), []);
  await built.app.close();
});

test('WebSocket is owner-bound by rep and exact creating session', async () => {
  const owner = await buildApp();
  await createMeeting(owner.app);
  await owner.app.close();

  for (const mismatch of [
    { authenticated: false },
    { wsUserId: OTHER_ID },
    { wsSessionId: 'different-session' },
  ]) {
    const built = await buildApp(mismatch);
    built.pool.meetings.push({ id: MEETING_ID, rep_id: REP_ID, owner_session_id: SESSION_ID, channel: UPLOADED_RECORDING_CHANNEL, status: 'active' });
    const ws = await built.app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
    const [code] = await once(ws, 'close');
    assert.ok([4001, 4003].includes(code), `unexpected close ${code}`);
    assert.equal(built.state.sessions.length, 0);
    await built.app.close();
  }
});

test('synthetic valid PCM streams to transcription, persists/fans out transcripts and coaching, then completes once', async () => {
  const { app, pool, state } = await buildApp();
  await createMeeting(app, 4);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  ws.send(start(4));
  await waitFor(() => state.sessions.length === 1);
  const pcm = Buffer.alloc(32_000, 7);
  ws.send(pcm);
  await waitFor(() => state.sessions[0].sent.length === 1);
  assert.deepEqual(state.sessions[0].sent[0], pcm);

  state.sessions[0].emit({ isFinal: false, text: 'interim words', speaker: 0, words: [] });
  for (let index = 0; index < 3; index += 1) {
    state.sessions[0].emit({
      isFinal: true, text: `final segment ${index + 1}`, speaker: index % 2,
      words: [{ start: index, end: index + 0.5, word: 'final' }],
    });
  }
  await waitFor(() => pool.segments.length === 3 && state.coachingCalls >= 1);
  assert.deepEqual(pool.segments.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: 'Speaker 1', text: 'final segment 1' },
    { speaker: 'Speaker 2', text: 'final segment 2' },
    { speaker: 'Speaker 1', text: 'final segment 3' },
  ]);
  assert.ok(state.broadcasts.some(({ payload }) => payload.type === 'interim'));
  assert.equal(state.broadcasts.filter(({ payload }) => payload.type === 'final').length, 3);
  assert.ok(state.broadcasts.some(({ payload }) => payload.type === 'coaching'));

  ws.send(JSON.stringify({ type: 'end' }));
  ws.send(JSON.stringify({ type: 'end' })); // duplicate completion is rejected/ignored, never finalized twice
  await once(ws, 'close');
  await waitFor(() => state.completed.length === 1);
  assert.deepEqual(state.completed, [MEETING_ID]);
  assert.equal(pool.meetings[0].status, 'completed');
  assert.equal(pool.meetings[0].summary, 'Synthetic summary');
  assert.equal(state.sessions[0].closed, true);
  assert.equal(state.broadcasts.filter(({ payload }) => payload.type === 'meeting_ended').length, 1);
  // Completion closed normally and did not run the interruption update.
  assert.ok(!pool.sqlLog.some((sql) => sql.includes("status = 'interrupted'")));
  assert.deepEqual(Object.keys(pool.meetings[0]).filter((key) => /audio|file|blob|path|url/i.test(key)), []);
  await app.close();
});

test('malformed and oversized/post-end audio close the socket without completing', async () => {
  for (const action of ['malformed', 'oversized']) {
    const { app, state } = await buildApp();
    const response = await createMeeting(app, 2);
    assert.equal(response.statusCode, 201);
    const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
    if (action === 'malformed') ws.send('{');
    else { ws.send(start(2)); ws.send(Buffer.alloc(65_538)); }
    const [code] = await once(ws, 'close');
    assert.ok([4400, 4409].includes(code));
    assert.equal(state.completed.length, 0);
    await app.close();
  }
});
