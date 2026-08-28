import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeFirst30SpeakerRepair,
  classifyContextualRole,
  createFirst30SpeakerRepairCoordinator,
  knownCustomerNameFromMeeting,
  persistFirst30SpeakerRepair,
  FIRST30_REPAIR_WINDOW_MS,
  PCM_BYTES_PER_SECOND,
} from '../first30SpeakerRepair.js';

const REP = 'Ada Lovelace';
const CUSTOMER = 'John Smith';

function segment(id, start, text, speaker = 'Speaker 1', slot = 0) {
  return { id, meeting_id: 'm1', ts: new Date(1_000_000 + start).toISOString(), speaker, text, word_count: text.split(/\s+/).length, duration_ms: 800, media_start_ms: start, media_end_ms: start + 800, speaker_slot: slot };
}

function meeting(overrides = {}) {
  return { id: 'm1', channel: 'in_person', call_sid: null, speaker_labels: {}, speaker_label_evidence: {}, first30_speaker_repair: {}, media_time_ms: 30_000, ...overrides };
}

const clearDialogue = [
  segment('s1', 500, "Hi John, I'm Ada with CertaPro."),
  segment('s2', 3_000, 'Hi Ada, thanks for coming.'),
  segment('s3', 7_000, 'What rooms would you like us to look at?'),
  segment('s4', 10_000, 'We want our kitchen and living room painted.'),
];

test('classifies introductions, questions, and first-person role cues without guessing neutral text', () => {
  assert.deepEqual(classifyContextualRole("Hi John, I'm Ada.", { repName: REP, customerName: CUSTOMER })?.role, 'rep');
  assert.deepEqual(classifyContextualRole("I'm John and we need our kitchen painted.", { repName: REP, customerName: CUSTOMER })?.role, 'customer');
  assert.deepEqual(classifyContextualRole('What rooms do you want painted?', { repName: REP, customerName: CUSTOMER })?.role, 'rep');
  assert.deepEqual(classifyContextualRole('We want our kitchen painted.', { repName: REP, customerName: CUSTOMER })?.role, 'customer');
  assert.equal(classifyContextualRole('Sounds good.', { repName: REP, customerName: CUSTOMER }), null);
});

test('repairs a falsely single-speaker opening while preserving all text, timestamps, order, ids, and source semantics', () => {
  const before = structuredClone(clearDialogue);
  const plan = analyzeFirst30SpeakerRepair({ meeting: meeting(), segments: clearDialogue, repName: REP, customerName: CUSTOMER });
  assert.equal(plan.status, 'applied');
  assert.deepEqual(plan.corrections.map(({ id, speaker }) => [id, speaker]), [
    ['s1', REP], ['s2', CUSTOMER], ['s3', REP], ['s4', CUSTOMER],
  ]);
  assert.deepEqual(clearDialogue, before, 'analysis must not mutate source transcript');
  assert.deepEqual(clearDialogue.map(({ id, text, ts, media_start_ms, media_end_ms }) => ({ id, text, ts, media_start_ms, media_end_ms })), before.map(({ id, text, ts, media_start_ms, media_end_ms }) => ({ id, text, ts, media_start_ms, media_end_ms })));
  assert.deepEqual(plan.slotLabels, {}, 'one corrupt slot carrying both people cannot become a global slot lock');
  assert.equal(plan.lastResolvedRole, 'customer');
});

test('maps clean distinct slots to known names and carries the mapping forward', () => {
  const segments = [
    segment('s1', 500, "Hi John, I'm Ada.", 'Speaker 4', 3),
    segment('s2', 3_000, "I'm John. We need our kitchen painted.", 'Speaker 8', 7),
  ];
  const plan = analyzeFirst30SpeakerRepair({ meeting: meeting(), segments, repName: REP, customerName: CUSTOMER });
  assert.equal(plan.slotLabels['3'].name, REP);
  assert.equal(plan.slotLabels['7'].name, CUSTOMER);
});

test('customer identity is read from existing speakerIdentity evidence before association fallback', () => {
  assert.equal(knownCustomerNameFromMeeting(meeting({
    customer_name: null,
    speaker_label_evidence: { 0: { method: 'introduction', role: 'rep', customer_candidate: CUSTOMER } },
  })), CUSTOMER);
  assert.equal(knownCustomerNameFromMeeting(meeting({
    customer_name: null,
    speaker_labels: { 'Speaker 2': CUSTOMER },
    speaker_label_evidence: { 1: { method: 'introduction', role: 'customer' } },
  })), CUSTOMER);
});

test('ambiguous context and missing names are deterministic no-ops', () => {
  const ambiguous = [segment('a', 1_000, 'Good morning.'), segment('b', 3_000, 'Sounds good.')];
  assert.equal(analyzeFirst30SpeakerRepair({ meeting: meeting(), segments: ambiguous, repName: REP, customerName: CUSTOMER }).status, 'no_op');
  assert.equal(analyzeFirst30SpeakerRepair({ meeting: meeting(), segments: clearDialogue, repName: REP, customerName: null }).reason, 'missing_distinct_known_identities');
});

test('manual locks remain authoritative and phone is excluded', () => {
  const manuallyLocked = meeting({ speaker_labels: { 'Speaker 1': 'Manual Person' }, speaker_label_evidence: {} });
  const plan = analyzeFirst30SpeakerRepair({ meeting: manuallyLocked, segments: clearDialogue, repName: REP, customerName: CUSTOMER });
  assert.equal(plan.corrections.length, 0);
  assert.equal(analyzeFirst30SpeakerRepair({ meeting: meeting({ channel: 'phone' }), segments: clearDialogue, repName: REP, customerName: CUSTOMER }).reason, 'excluded_channel');
  assert.equal(analyzeFirst30SpeakerRepair({ meeting: meeting({ call_sid: 'CA123' }), segments: clearDialogue, repName: REP, customerName: CUSTOMER }).reason, 'excluded_channel');
});

function makePool({ currentMeeting = meeting(), segments = structuredClone(clearDialogue) } = {}) {
  const queries = [];
  let repairUpdates = 0;
  const client = {
    async query(sql, params = []) {
      sql = String(sql); queries.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT * FROM meetings') && sql.includes('FOR UPDATE')) return { rows: [currentMeeting], rowCount: 1 };
      if (sql.includes('FROM transcript_segments') && sql.includes('FOR UPDATE')) return { rows: segments, rowCount: segments.length };
      if (sql.includes('UPDATE transcript_segments SET speaker')) {
        const row = segments.find(item => item.id === params[1] && item.meeting_id === params[2] && item.speaker === params[3]);
        if (!row) return { rows: [], rowCount: 0 };
        row.speaker = params[0]; return { rows: [], rowCount: 1 };
      }
      if (sql.includes('first30_speaker_repair =')) {
        repairUpdates += 1;
        currentMeeting.media_time_ms = Math.max(currentMeeting.media_time_ms || 0, params[1]);
        currentMeeting.first30_speaker_repair = JSON.parse(params[2]);
        currentMeeting.speaker_labels = { ...(currentMeeting.speaker_labels || {}), ...JSON.parse(params[3]) };
        currentMeeting.speaker_label_evidence = { ...(currentMeeting.speaker_label_evidence || {}), ...JSON.parse(params[4]) };
        return { rows: [{ speaker_labels: currentMeeting.speaker_labels, speaker_label_evidence: currentMeeting.speaker_label_evidence, first30_speaker_repair: currentMeeting.first30_speaker_repair }], rowCount: 1 };
      }
      if (sql.includes('UPDATE meetings SET media_time_ms')) {
        currentMeeting.media_time_ms = Math.max(currentMeeting.media_time_ms || 0, params[1]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };
  return { connect: async () => client, query: (...args) => client.query(...args), queries, segments, currentMeeting, get repairUpdates() { return repairUpdates; } };
}

test('atomic persistence is exactly once across retry/restart and broadcasts corrected row ids', async () => {
  const pool = makePool();
  const first = await persistFirst30SpeakerRepair({ pool, meetingId: 'm1', repName: REP, customerName: CUSTOMER, observedMediaMs: 30_000 });
  assert.equal(first.attempted, true);
  assert.equal(pool.repairUpdates, 1);
  assert.deepEqual(pool.segments.map(item => item.speaker), [REP, CUSTOMER, REP, CUSTOMER]);
  const second = await persistFirst30SpeakerRepair({ pool, meetingId: 'm1', repName: REP, customerName: CUSTOMER, observedMediaMs: 35_000 });
  assert.equal(second.attempted, false);
  assert.equal(second.reason, 'already_attempted');
  assert.equal(pool.repairUpdates, 1);
  assert.equal(pool.currentMeeting.first30_speaker_repair.corrections.length, 4);
  assert.match(pool.currentMeeting.first30_speaker_repair.transcript_fingerprint_sha256, /^[a-f0-9]{64}$/);
});

test('threshold uses media bytes, not wall clock or pause time; short recordings never trigger', async () => {
  const pool = makePool({ currentMeeting: meeting({ media_time_ms: 0 }) });
  const broadcasts = [];
  const coordinator = createFirst30SpeakerRepairCoordinator({ pool, meeting: pool.currentMeeting, repName: REP, customerName: CUSTOMER, broadcastToMeeting: (id, payload) => broadcasts.push(payload) });
  coordinator.noteAcceptedMediaBytes(29 * PCM_BYTES_PER_SECOND);
  assert.equal((await coordinator._attempt()).reason, 'threshold_not_reached');
  // Arbitrary wall-clock time is irrelevant; only one more second of PCM
  // accepted by the transcription provider crosses the gate.
  coordinator.noteAcceptedMediaBytes(PCM_BYTES_PER_SECOND);
  await coordinator.afterSegmentPersisted();
  assert.equal(broadcasts.filter(item => item.type === 'speaker_repair').length, 1);
  assert.deepEqual(broadcasts[0].corrections.map(item => item.id), ['s1', 's2', 's3', 's4']);
  await coordinator._attempt();
  assert.equal(broadcasts.length, 1);
  assert.equal(coordinator.currentMediaMs(), FIRST30_REPAIR_WINDOW_MS);
});

test('in-person and uploaded recording are eligible and later explicit context continues repaired attribution', async () => {
  for (const channel of ['in_person', 'uploaded_recording']) {
    const pool = makePool({ currentMeeting: meeting({ channel }) });
    const learned = {};
    const coordinator = createFirst30SpeakerRepairCoordinator({ pool, meeting: pool.currentMeeting, repName: REP, customerName: CUSTOMER, onSlotLabels: labels => Object.assign(learned, labels) });
    coordinator.noteAcceptedMediaBytes(30 * PCM_BYTES_PER_SECOND);
    await coordinator._attempt();
    assert.equal(coordinator.labelForSegment({ speakerIndex: 0, text: 'We want our exterior painted.', defaultLabel: 'Speaker 1' }), CUSTOMER);
    assert.equal(coordinator.labelForSegment({ speakerIndex: 0, text: 'Okay.', defaultLabel: 'Speaker 1' }), 'Speaker 1', 'ambiguous later text is never guessed');
    assert.deepEqual(learned, {});
  }
});

test('phone/CallSid meetings are completely untouched end-to-end: no DB writes, no broadcasts, no label changes', async () => {
  for (const phoneMeeting of [meeting({ channel: 'phone' }), meeting({ channel: 'in_person', call_sid: 'CA_legacy_defense_in_depth' })]) {
    const pool = makePool({ currentMeeting: phoneMeeting, segments: structuredClone(clearDialogue) });
    const broadcasts = [];
    const coordinator = createFirst30SpeakerRepairCoordinator({
      pool, meeting: pool.currentMeeting, repName: REP, customerName: CUSTOMER,
      broadcastToMeeting: (id, payload) => broadcasts.push(payload),
    });
    assert.equal(coordinator.enabled, false);
    coordinator.noteAcceptedMediaBytes(60 * PCM_BYTES_PER_SECOND);
    const attemptResult = await coordinator._attempt();
    assert.equal(attemptResult.attempted, false);
    assert.equal(attemptResult.reason, 'excluded_channel');
    await coordinator.afterSegmentPersisted();
    await coordinator.flush();
    assert.equal(broadcasts.length, 0, 'phone meetings must never broadcast a speaker_repair event');
    assert.equal(pool.repairUpdates, 0, 'phone meetings must never write first30_speaker_repair state');
    assert.deepEqual(pool.segments.map(item => item.speaker), clearDialogue.map(item => item.speaker), 'phone transcript speakers are untouched');
    assert.equal(pool.currentMeeting.media_time_ms, phoneMeeting.media_time_ms, 'phone meetings never get their media cursor advanced by this code path');
    assert.equal(
      coordinator.labelForSegment({ speakerIndex: 0, text: "Hi John, I'm Ada.", defaultLabel: 'Speaker 1' }),
      'Speaker 1',
      'phone meetings keep channel/track-based labels untouched',
    );
  }
});

test('reconnect/retry cannot double-apply: a brand-new coordinator built from the already-persisted meeting row is a no-op', async () => {
  const pool = makePool();
  const broadcastsFirstConnection = [];
  const firstConnection = createFirst30SpeakerRepairCoordinator({
    pool, meeting: pool.currentMeeting, repName: REP, customerName: CUSTOMER,
    broadcastToMeeting: (id, payload) => broadcastsFirstConnection.push(payload),
  });
  firstConnection.noteAcceptedMediaBytes(30 * PCM_BYTES_PER_SECOND);
  const firstResult = await firstConnection._attempt();
  assert.equal(firstResult.attempted, true);
  assert.equal(pool.repairUpdates, 1);
  const persistedSpeakersAfterFirstConnection = pool.segments.map(item => item.speaker);
  assert.deepEqual(persistedSpeakersAfterFirstConnection, [REP, CUSTOMER, REP, CUSTOMER]);

  // Simulate a socket drop + reconnect: a fresh coordinator instance is
  // constructed (as server.js does per-connection) from the SAME meeting
  // row now reflecting the already-persisted repair state/media_time_ms.
  const broadcastsSecondConnection = [];
  const secondConnection = createFirst30SpeakerRepairCoordinator({
    pool, meeting: pool.currentMeeting, repName: REP, customerName: CUSTOMER,
    broadcastToMeeting: (id, payload) => broadcastsSecondConnection.push(payload),
  });
  // The reconnecting socket immediately replays/continues sending media
  // bytes past the threshold again, and even a duplicate persisted segment
  // arrives (retry semantics) before the app notices the socket is stale.
  secondConnection.noteAcceptedMediaBytes(10 * PCM_BYTES_PER_SECOND);
  const secondResult = await secondConnection._attempt();
  await secondConnection.afterSegmentPersisted();
  assert.equal(secondConnection.enabled, true, 'channel eligibility itself is unaffected by reconnect');
  assert.equal(secondResult.attempted, false);
  assert.equal(secondResult.reason, 'already_attempted');
  assert.equal(pool.repairUpdates, 1, 'no second write across the reconnect');
  assert.equal(broadcastsSecondConnection.length, 0, 'no duplicate speaker_repair broadcast on reconnect');
  assert.deepEqual(pool.segments.map(item => item.speaker), persistedSpeakersAfterFirstConnection, 'no double-apply / no re-correction on reconnect');
});
