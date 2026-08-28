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
  UPLOADED_RECORDING_PROTOCOL,
} from '../uploadedRecording.js';

const REP_ID = 'rep-1';
const OTHER_ID = 'rep-2';
const SESSION_ID = 'session-owner';
const MEETING_ID = 'meeting-upload-1';

function waitFor(predicate, timeoutMs = 2_000, label = '') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out${label ? `: ${label}` : ''}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makePool() {
  const meetings = [];
  const segments = [];
  const sqlLog = [];
  const pool = {
    meetings, segments, sqlLog,
    connect: async () => ({ query: (...args) => pool.query(...args), release() {} }),
    async query(sql, params = []) {
      sqlLog.push(sql);
      if (sql.includes('INSERT INTO meetings')) {
        const row = {
          id: MEETING_ID, customer_id: params[0], rep_id: params[1], status: 'active',
          owner_session_id: params[2], origin_client: 'web', channel: params[3], summary: null,
          started_at: new Date(), speaker_labels: {}, speaker_label_evidence: {}, customer_name: null,
          media_time_ms: 0, first30_speaker_repair: {},
        };
        meetings.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM meetings m LEFT JOIN customers c') || sql === 'SELECT * FROM meetings WHERE id = $1' || sql.includes('SELECT * FROM meetings WHERE id = $1 FOR UPDATE')) {
        return { rows: meetings.filter((m) => m.id === params[0]) };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('FROM transcript_segments') && sql.includes('FOR UPDATE')) {
        return { rows: segments.filter((row) => row.meeting_id === params[0] && row.media_start_ms < params[1]), rowCount: segments.length };
      }
      if (sql.includes('UPDATE meetings SET media_time_ms')) {
        const meeting = meetings.find((row) => row.id === params[0]);
        if (meeting) meeting.media_time_ms = Math.max(meeting.media_time_ms || 0, params[1]);
        return { rows: [], rowCount: meeting ? 1 : 0 };
      }
      if (sql.includes('first30_speaker_repair =')) {
        const meeting = meetings.find((row) => row.id === params[0]);
        if (!meeting) return { rows: [], rowCount: 0 };
        meeting.media_time_ms = Math.max(meeting.media_time_ms || 0, params[1]);
        meeting.first30_speaker_repair = JSON.parse(params[2]);
        meeting.speaker_labels = { ...(meeting.speaker_labels || {}), ...JSON.parse(params[3]) };
        meeting.speaker_label_evidence = { ...(meeting.speaker_label_evidence || {}), ...JSON.parse(params[4]) };
        return { rows: [{ speaker_labels: meeting.speaker_labels, speaker_label_evidence: meeting.speaker_label_evidence, first30_speaker_repair: meeting.first30_speaker_repair }], rowCount: 1 };
      }
      if (sql.includes('UPDATE meetings') && sql.includes('speaker_label_evidence')) {
        const meeting = meetings.find((m) => m.id === params[2]);
        const speakerId = params[3];
        const evidenceKey = params[4];
        if (!meeting || meeting.speaker_labels[speakerId] || Object.values(meeting.speaker_labels).some((name) => name.toLowerCase() === String(params[0]).toLowerCase())) {
          return { rows: [], rowCount: 0 };
        }
        meeting.speaker_labels[speakerId] = params[0];
        meeting.speaker_label_evidence[evidenceKey] = JSON.parse(params[1]);
        return { rows: [{ speaker_labels: { ...meeting.speaker_labels }, speaker_label_evidence: { ...meeting.speaker_label_evidence } }], rowCount: 1 };
      }
      if (sql.includes('UPDATE transcript_segments SET speaker = $1')) {
        let count = 0;
        for (const segment of segments) {
          const contextualRepair = sql.includes('WHERE id = $2');
          const matches = contextualRepair
            ? segment.id === params[1] && segment.meeting_id === params[2] && segment.speaker === params[3]
            : segment.meeting_id === params[1] && segment.speaker === params[2];
          if (matches) {
            segment.speaker = params[0];
            count += 1;
          }
        }
        return { rows: [], rowCount: count };
      }
      if (sql === 'SELECT status FROM meetings WHERE id = $1') {
        return { rows: meetings.filter((m) => m.id === params[0]).map(({ status }) => ({ status })) };
      }
      if (sql.includes('INSERT INTO transcript_segments')) {
        const row = {
          id: `segment-${segments.length + 1}`, ts: new Date(), meeting_id: params[0],
          speaker: params[1], text: params[2], word_count: params[3], duration_ms: params[4],
          media_start_ms: params[5], media_end_ms: params[6], speaker_slot: params[7],
        };
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
  return pool;
}

function makeTranscriptionFactory(state) {
  return ({ onTranscript, onAudioAccepted }) => {
    const session = {
      sent: [], closed: false,
      send(buffer) {
        this.sent.push(Buffer.from(buffer));
        onAudioAccepted?.(buffer.byteLength);
      },
      close() { this.closed = true; },
      emit(result) { onTranscript(result); },
    };
    state.sessions.push(session);
    return session;
  };
}

async function buildApp({
  authenticated = true,
  wsUserId = REP_ID,
  wsSessionId = SESSION_ID,
  apiKey = 'dg-key',
  wsAuthGate = null,
  createTranscriptionSession = null,
  finalizeMeeting = null,
  now = () => Date.now(),
} = {}) {
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
    authWebSocketWithSession: async () => {
      if (wsAuthGate) await wsAuthGate.promise;
      return {
        user: authenticated ? { id: wsUserId, role: 'rep', name: 'Ada' } : null,
        sessionId: authenticated ? wsSessionId : null,
      };
    },
    createTranscriptionSession: createTranscriptionSession || makeTranscriptionFactory(state),
    broadcastToMeeting: (meetingId, payload) => state.broadcasts.push({ meetingId, payload }),
    registerMeetingSocket: (meetingId) => state.registered.push(meetingId),
    unregisterMeetingSocket: (meetingId) => state.unregistered.push(meetingId),
    runCoachingAnalysis: async () => {
      state.coachingCalls += 1;
      return { stage: { current: 'proposal' } };
    },
    finalizeMeeting: finalizeMeeting
      ? (meetingId) => finalizeMeeting({ meetingId, pool, state })
      : async (meetingId) => {
        const meeting = pool.meetings.find((m) => m.id === meetingId);
        assert.equal(meeting.status, 'active');
        meeting.status = 'completed';
        meeting.summary = 'Synthetic summary';
        state.completed.push(meetingId);
        return { summary: meeting.summary };
      },
    transcriptDrainMs: 0,
    now,
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

test('protocol preserves pause/resume pacing through minute five and accepts bounded heartbeats', () => {
  let now = 0;
  const protocol = createUploadedRecordingProtocol({ now: () => now });
  assert.deepEqual(protocol.handleControl(start(360)), { type: 'started' });

  // Real-time PCM through minute four.
  for (let second = 0; second < 240; second += 1) {
    protocol.handleBinary(Buffer.alloc(UPLOADED_RECORDING_PROTOCOL.bytesPerSecond));
    now += 1_000;
  }

  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'pause' })), { type: 'paused' });
  for (let elapsed = 0; elapsed < 65_000; elapsed += 20_000) {
    now += 20_000;
    assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'heartbeat' })), { type: 'heartbeat' });
  }
  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'resume' })), { type: 'resumed' });

  // Continued PCM at roughly minute five must retain the pre-pause pacing
  // allowance rather than resetting or counting paused wall time as audio.
  for (let second = 0; second < 5; second += 1) {
    now += 1_000;
    protocol.handleBinary(Buffer.alloc(UPLOADED_RECORDING_PROTOCOL.bytesPerSecond));
  }
  assert.deepEqual(protocol.handleControl(JSON.stringify({ type: 'end' })), {
    type: 'ended',
    receivedBytes: 245 * UPLOADED_RECORDING_PROTOCOL.bytesPerSecond,
  });
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
  assert.equal(Object.hasOwn(response.json(), 'owner_session_id'), false);
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

test('WebSocket retains immediate start and PCM frames in strict order during async setup', async () => {
  const wsAuthGate = deferred();
  const { app, state } = await buildApp({ wsAuthGate });
  await createMeeting(app, 4);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  const pcm1 = Buffer.alloc(12_000, 0x11);
  const pcm2 = Buffer.alloc(20_000, 0x22);

  ws.send(start(4));
  ws.send(pcm1);
  ws.send(pcm2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.sessions.length, 0, 'async authentication should still be blocked');

  wsAuthGate.resolve();
  await waitFor(() => state.sessions[0]?.sent.length === 2);
  assert.deepEqual(state.sessions[0].sent, [pcm1, pcm2]);

  ws.close();
  await once(ws, 'close');
  await app.close();
});

test('WebSocket setup queue rejects count and byte overflow without starting transcription', async () => {
  for (const overflow of ['count', 'bytes']) {
    const wsAuthGate = deferred();
    const { app, state } = await buildApp({ wsAuthGate });
    await createMeeting(app, 20);
    const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
    const closed = once(ws, 'close');

    if (overflow === 'count') {
      for (let index = 0; index <= UPLOADED_RECORDING_PROTOCOL.maxSetupQueuedFrames; index += 1) {
        ws.send(JSON.stringify({ type: 'pause', index }));
      }
    } else {
      ws.send(start(20));
      const chunk = Buffer.alloc(UPLOADED_RECORDING_PROTOCOL.maxChunkBytes);
      for (let index = 0; index < 5; index += 1) ws.send(chunk);
    }

    const [code] = await closed;
    assert.equal(code, 4409, `${overflow} overflow should be rejected`);
    wsAuthGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.sessions.length, 0);
    await app.close();
  }
});

test('WebSocket auth, meeting, and transcription setup failures close and discard queued frames', async () => {
  for (const failure of ['auth', 'meeting', 'transcription']) {
    const wsAuthGate = deferred();
    const { app, state } = await buildApp({
      wsAuthGate,
      createTranscriptionSession: failure === 'transcription'
        ? () => { throw new Error('synthetic transcription setup failure'); }
        : null,
    });
    if (failure !== 'meeting') await createMeeting(app, 2);
    const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
    ws.send(start(2));
    ws.send(Buffer.alloc(32_000, 7));
    const closed = once(ws, 'close');
    if (failure === 'auth') wsAuthGate.reject(new Error('synthetic auth failure'));
    else wsAuthGate.resolve();

    const [code] = await closed;
    assert.equal(code, failure === 'meeting' ? 4004 : 1011, `${failure} failure close code`);
    assert.equal(state.sessions.length, 0, `${failure} failure must not consume queued PCM`);
    assert.deepEqual(state.registered, failure === 'transcription' ? [MEETING_ID] : []);
    assert.deepEqual(state.unregistered, failure === 'transcription' ? [MEETING_ID] : []);
    await app.close();
  }
});

test('synthetic valid PCM streams to transcription, persists/fans out transcripts and coaching, then completes once', async () => {
  const { app, pool, state } = await buildApp();
  await createMeeting(app, 4);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
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

  ws.send(JSON.stringify({ type: 'pause' }));
  ws.send(JSON.stringify({ type: 'heartbeat' }));
  ws.send(JSON.stringify({ type: 'resume' }));
  await waitFor(() => messages.some(({ type }) => type === 'heartbeat'));

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

test('uploaded recording first-30 repair advances only on transcription-accepted media and broadcasts corrected rows once', async () => {
  const held = { options: null, sent: [] };
  const createTranscriptionSession = (options) => {
    held.options = options;
    return {
      send(buffer) { held.sent.push(Buffer.from(buffer)); },
      close() {},
      emit(result) { options.onTranscript(result); },
    };
  };
  const { app, pool, state } = await buildApp({ createTranscriptionSession });
  const created = await createMeeting(app, 31);
  assert.equal(created.statusCode, 201);
  pool.meetings[0].customer_name = 'John';
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  ws.send(start(31));
  await waitFor(() => held.options !== null, 2_000, 'transcription options');

  // Receiving PCM is not enough: until the provider/session explicitly
  // accepts it, the persisted media cursor and repair state remain untouched.
  ws.send(Buffer.alloc(UPLOADED_RECORDING_PROTOCOL.bytesPerSecond, 7));
  await waitFor(() => held.sent.length === 1, 2_000, 'PCM delivered to transcription stub');
  assert.equal(pool.meetings[0].media_time_ms, 0);
  assert.deepEqual(pool.meetings[0].first30_speaker_repair, {});

  held.options.onTranscript({
    isFinal: true, text: "Hi John, I'm Ada with CertaPro.", speaker: 0,
    words: [{ start: 0.5, end: 1.4, word: 'Hi' }],
  });
  held.options.onTranscript({
    isFinal: true, text: 'We want our kitchen painted.', speaker: 0,
    words: [{ start: 3, end: 4, word: 'We' }],
  });
  await waitFor(() => pool.segments.length === 2, 2_000, 'first two transcript rows');
  assert.equal(state.broadcasts.some(({ payload }) => payload.type === 'speaker_repair'), false);

  held.options.onAudioAccepted(30 * UPLOADED_RECORDING_PROTOCOL.bytesPerSecond);
  // Crossing the threshold must repair the already-persisted 0-30s window;
  // a post-threshold transcript is not required to kick the attempt.
  await waitFor(() => state.broadcasts.some(({ payload }) => payload.type === 'speaker_repair'), 2_000, `repair broadcast; rows=${pool.segments.length} state=${JSON.stringify(pool.meetings[0].first30_speaker_repair)}`);
  const repair = state.broadcasts.find(({ payload }) => payload.type === 'speaker_repair').payload;
  assert.deepEqual(repair.corrections.map(({ id, speaker }) => [id, speaker]), [
    ['segment-1', 'Ada'], ['segment-2', 'John'],
  ]);
  assert.deepEqual(pool.segments.map(({ speaker }) => speaker), ['Ada', 'John']);
  assert.equal(pool.meetings[0].first30_speaker_repair.status, 'applied');
  assert.equal(pool.meetings[0].media_time_ms, 30_000);

  // Retried accepted-media notifications and later finals cannot reapply or
  // emit a second correction event after the terminal state is committed.
  held.options.onAudioAccepted(UPLOADED_RECORDING_PROTOCOL.bytesPerSecond);
  held.options.onTranscript({
    isFinal: true, text: 'We need the hallway painted.', speaker: 0,
    words: [{ start: 31, end: 32, word: 'We' }],
  });
  await waitFor(() => pool.segments.length === 3, 2_000, 'later transcript row');
  assert.equal(state.broadcasts.filter(({ payload }) => payload.type === 'speaker_repair').length, 1);
  assert.equal(pool.segments[2].speaker, 'John');

  ws.close();
  await once(ws, 'close');
  await app.close();
});

test('uploaded recording automatically labels, persists, relabels prior rows, and broadcasts both identities', async () => {
  let clock = 1_000_000;
  const { app, pool, state } = await buildApp({ now: () => clock });
  const created = await createMeeting(app, 4);
  assert.equal(created.statusCode, 201);
  pool.meetings[0].started_at = new Date(clock);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  ws.send(start(4));
  await waitFor(() => state.sessions.length === 1);
  ws.send(Buffer.alloc(32_000, 7));
  await waitFor(() => state.sessions[0].sent.length === 1);

  state.sessions[0].emit({
    isFinal: true, text: 'Hi John, this is Ada.', speaker: 4,
    words: [{ start: 0, end: 0.8, word: 'Hi' }],
  });
  await waitFor(() => pool.meetings[0].speaker_labels['Speaker 5'] === 'Ada');
  assert.equal(pool.meetings[0].speaker_labels['Speaker 5'], 'Ada');
  assert.equal(pool.meetings[0].speaker_labels['Speaker 10'], undefined);
  assert.equal(pool.segments[0].speaker, 'Ada');

  clock += 35_000;
  state.sessions[0].emit({
    isFinal: true, text: 'The kitchen needs paint.', speaker: 9,
    words: [{ start: 35, end: 36, word: 'kitchen' }],
  });
  await waitFor(() => pool.meetings[0].speaker_labels['Speaker 10'] === 'John');
  assert.equal(pool.segments[1].speaker, 'John');
  assert.equal(pool.meetings[0].speaker_label_evidence['4'].customer_candidate, 'John');
  assert.equal(pool.meetings[0].speaker_label_evidence['9'].distinct_speaker_segment_id, 'segment-2');
  assert.deepEqual(state.broadcasts.filter(({ payload }) => payload.type === 'speaker_lock').map(({ payload }) => ({
    speakerId: payload.speakerId, name: payload.name, role: payload.role, source: payload.source,
  })), [
    { speakerId: 'Speaker 5', name: 'Ada', role: 'rep', source: 'introduction' },
    { speakerId: 'Speaker 10', name: 'John', role: 'customer', source: 'introduction' },
  ]);

  ws.close();
  await once(ws, 'close');
  await app.close();
});

test('post-status summary failure still acknowledges the finalized meeting instead of Completion failed', async () => {
  const { app, pool, state } = await buildApp({
    finalizeMeeting: async ({ meetingId, pool: testPool, state: testState }) => {
      const meeting = testPool.meetings.find((row) => row.id === meetingId);
      assert.equal(meeting.status, 'active');
      meeting.status = 'completed';
      testState.completed.push(meetingId);
      throw new Error('synthetic summary generation failure');
    },
  });
  await createMeeting(app, 2);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  ws.send(start(2));
  await waitFor(() => state.sessions.length === 1);
  ws.send(Buffer.alloc(32_000, 7));
  await waitFor(() => state.sessions[0].sent.length === 1);
  ws.send(JSON.stringify({ type: 'end' }));

  const [code] = await once(ws, 'close');
  assert.equal(code, 1000);
  assert.equal(pool.meetings[0].status, 'completed');
  assert.deepEqual(state.completed, [MEETING_ID]);
  assert.equal(messages.filter(({ type }) => type === 'completed').length, 1);
  assert.equal(messages.some(({ type, error }) => type === 'error' && error === 'Completion failed'), false);
  await app.close();
});

test('pre-status finalization failure remains a truthful Completion failed protocol error', async () => {
  const { app, pool, state } = await buildApp({
    finalizeMeeting: async () => { throw new Error('synthetic status update failure'); },
  });
  await createMeeting(app, 2);
  const ws = await app.injectWS(`/meetings/${MEETING_ID}/uploaded-recording`);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  ws.send(start(2));
  await waitFor(() => state.sessions.length === 1);
  ws.send(Buffer.alloc(32_000, 7));
  await waitFor(() => state.sessions[0].sent.length === 1);
  ws.send(JSON.stringify({ type: 'end' }));

  const [code] = await once(ws, 'close');
  assert.equal(code, 1011);
  assert.equal(pool.meetings[0].status, 'active');
  assert.deepEqual(state.completed, []);
  assert.equal(messages.some(({ type, error }) => type === 'error' && error === 'Completion failed'), true);
  assert.equal(messages.some(({ type }) => type === 'completed'), false);
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
