import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTwoPersonIntroduction,
  createInPersonIntroductionLabeler,
  persistIntroductionResolution,
  isEligibleInPersonMeeting,
  INTRODUCTION_WINDOW_MS,
} from '../inPersonIntroductionLabels.js';

const phrases = [
  ["Hi John, this is Gabe.", 'Gabe', 'John', 'address_then_self'],
  ['John, thanks for meeting.', null, 'John', 'customer_thanks'],
  ["I'm Gabe and this is John.", 'Gabe', 'John', 'self_then_customer'],
  ["My name is Gabe; this is Sarah.", 'Gabe', 'Sarah', 'self_then_customer'],
  ["I'm Gabe and I'm here with Sarah.", 'Gabe', 'Sarah', 'self_here_with'],
  ["I'm Gabe with CertaPro, and you're Sarah, right?", 'Gabe', 'Sarah', 'self_then_you_are'],
  ["Hello D'Angelo, I am Mary-Jane.", 'Mary-Jane', "D'Angelo", 'address_then_self'],
];
for (const [phrase, selfName, customerName, pattern] of phrases) {
  test(`extracts required introduction shape: ${phrase}`, () => {
    const parsed = parseTwoPersonIntroduction(phrase);
    assert.equal(parsed?.selfName, selfName);
    assert.equal(parsed?.customerName, customerName);
    assert.equal(parsed?.pattern, pattern);
  });
}

for (const phrase of [
  'Hi CertaPro, this is Gabe.',
  'Homeowner, thanks for meeting.',
  "I'm Gabe and this is the customer.",
  "I'm starting and this is painting.",
  "I'm Gabe and this is John and Sarah.",
  'John from Acme, thanks for meeting.',
  'Yesterday I said hi John, this is Gabe.',
]) {
  test(`rejects generic, role, company, list, or non-opening evidence: ${phrase}`, () => {
    assert.equal(parseTwoPersonIntroduction(phrase), null);
  });
}

function fixture(overrides = {}) {
  const calls = [];
  const conflicts = [];
  let clock = 1_000_000;
  const labeler = createInPersonIntroductionLabeler({
    meetingType: 'in_person', repDisplayName: 'Gabriel Gabe Bass', startedAtMs: clock,
    now: () => clock,
    resolveIdentity: async (identity) => { calls.push(identity); return { resolved: true }; },
    onConflict: (value) => conflicts.push(value),
    ...overrides,
  });
  return {
    labeler, calls, conflicts,
    tick(ms) { clock += ms; return clock; },
    segment(speakerIndex, text, extra = {}) {
      return labeler.onSegment({
        id: extra.id || `seg-${speakerIndex}-${clock}`, speakerIndex, text,
        ts: new Date(clock).toISOString(), timestampMs: clock, ...extra,
      });
    },
  };
}

for (const phrase of ["Hi John, this is Gabe.", 'John, thanks for meeting.', "I'm Gabe and this is John."]) {
  test(`maps rep and late customer for phrase: ${phrase}`, async () => {
    const f = fixture();
    const first = await f.segment(4, phrase, { id: 'intro-row' });
    assert.equal(first.rep.resolved, true);
    assert.equal(first.pendingCustomer, true);
    assert.deepEqual(f.calls.map(({ speakerIndex, name, role }) => ({ speakerIndex, name, role })), [
      { speakerIndex: 4, name: 'Gabriel Gabe Bass', role: 'rep' },
    ]);
    f.tick(35_000);
    const second = await f.segment(9, 'We want to repaint the kitchen.', { id: 'customer-row' });
    assert.equal(second.customer.resolved, true);
    assert.deepEqual(f.calls.map(({ speakerIndex, name, role }) => ({ speakerIndex, name, role })), [
      { speakerIndex: 4, name: 'Gabriel Gabe Bass', role: 'rep' },
      { speakerIndex: 9, name: 'John', role: 'customer' },
    ]);
    assert.equal(f.calls[0].evidence.transcript_segment_id, 'intro-row');
    assert.equal(f.calls[0].evidence.customer_candidate, 'John');
    assert.equal(f.calls[1].evidence.distinct_speaker_segment_id, 'customer-row');
  });
}

test('one Deepgram slot through 30 seconds never receives both identities', async () => {
  const f = fixture();
  await f.segment(0, "Hi John, this is Gabe.");
  f.tick(INTRODUCTION_WINDOW_MS + 5_000);
  const result = await f.segment(0, 'Let me explain the estimate.');
  assert.deepEqual(result, { enabled: true });
  assert.equal(f.labeler._state().pending.customerName, 'John');
  assert.equal(f.calls.length, 1);
  assert.equal(f.labeler.getLock(0), 'Gabriel Gabe Bass');
  assert.equal([...f.labeler._state().locks.values()].includes('John'), false);
});

test('distinct second slot already seen resolves immediately after rep evidence', async () => {
  const f = fixture();
  assert.deepEqual(await f.segment(8, 'Good morning.'), { enabled: true });
  f.tick(200);
  const result = await f.segment(2, "I'm Gabe and this is John.");
  assert.equal(result.customer.resolved, true);
  assert.deepEqual(f.calls.map((call) => [call.speakerIndex, call.role]), [[2, 'rep'], [8, 'customer']]);
});

test('known customer association is canonical supporting evidence', async () => {
  const f = fixture({ customerDisplayName: 'John Smith' });
  await f.segment(3, 'John, thanks for meeting.');
  f.tick(500);
  await f.segment(7, 'Glad to be here.');
  assert.equal(f.calls[1].name, 'John Smith');
  assert.equal(f.calls[0].evidence.customer_source, 'customer_association_confirmed_by_introduction');
});

test('known customer can support self-only rep introduction', async () => {
  const f = fixture({ customerDisplayName: 'John Smith' });
  await f.segment(3, "Hi, I'm Gabe.");
  f.tick(500);
  await f.segment(7, 'Glad to be here.');
  assert.deepEqual(f.calls.map((call) => call.name), ['Gabriel Gabe Bass', 'John Smith']);
  assert.equal(f.calls[0].evidence.customer_source, 'customer_association');
});

test('unknown customer works independently from association', async () => {
  const f = fixture({ customerDisplayName: null });
  await f.segment(1, "Hi John, this is Gabe.");
  f.tick(500);
  await f.segment(2, 'Hello.');
  assert.equal(f.calls.at(-1).name, 'John');
});

test('conflicting authenticated rep evidence refuses all labels', async () => {
  const f = fixture();
  const result = await f.segment(0, "Hi John, this is Michael.");
  assert.equal(result.conflict.reason, 'authenticated_rep_name_conflict');
  assert.equal(f.calls.length, 0);
});

test('conflicting associated customer evidence refuses all labels', async () => {
  const f = fixture({ customerDisplayName: 'Sarah Jones' });
  const result = await f.segment(0, "Hi John, this is Gabe.");
  assert.equal(result.conflict.reason, 'associated_customer_name_conflict');
  assert.equal(f.calls.length, 0);
});

test('three observed slots make customer mapping ambiguous and permanent', async () => {
  const f = fixture();
  await f.segment(5, 'Morning.');
  await f.segment(6, 'Hello.');
  const result = await f.segment(1, "I'm Gabe and this is John.");
  assert.equal(result.conflict.reason, 'ambiguous_customer_slot');
  assert.equal(f.calls.filter((call) => call.role === 'customer').length, 0);
  await f.segment(5, 'Another line.');
  assert.equal(f.calls.filter((call) => call.role === 'customer').length, 0);
});

test('manual locks win and cancel pending automatic identity', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe and this is John.");
  f.labeler.setManualLock(1, 'Manually Named Customer');
  f.tick(500);
  const result = await f.segment(1, 'Hello.');
  assert.deepEqual(result, { enabled: true });
  assert.equal(f.labeler.getLock(1), 'Manually Named Customer');
  assert.equal(f.calls.filter((call) => call.role === 'customer').length, 0);
});

test('manual lock on pending rep clears stale automatic evidence', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe and this is John.");
  f.labeler.setManualLock(0, 'Manual Rep');
  f.tick(500);
  await f.segment(1, 'Hello.');
  assert.equal(f.calls.filter((call) => call.role === 'customer').length, 0);
  assert.equal(f.labeler.getLock(0), 'Manual Rep');
});

test('reconnect restores pending customer and resolves idempotently', async () => {
  const calls = [];
  const evidence = {
    3: {
      method: 'introduction', role: 'rep', pattern: 'address_then_self', confidence: 0.99,
      transcript_segment_id: 'intro', transcript_ts: new Date(1_000_000).toISOString(),
      customer_candidate: 'John', customer_source: 'introduction',
    },
  };
  const f = fixture({
    existingLocks: { 3: { name: 'Gabriel Gabe Bass', source: 'introduction' } },
    existingEvidence: evidence,
    resolveIdentity: async (value) => { calls.push(value); return { resolved: true }; },
  });
  const result = await f.segment(8, 'Hello after reconnect.');
  assert.equal(result.customer.resolved, true);
  assert.deepEqual(calls.map(({ role, name }) => ({ role, name })), [{ role: 'customer', name: 'John' }]);
  await f.segment(8, 'Second final.');
  assert.equal(calls.length, 1);
});

test('introduction locks block spectral aliases in both directions', async () => {
  const f = fixture();
  await f.segment(3, "I'm Gabe and this is John.");
  assert.deepEqual(f.labeler.addAlias(3, 1), { aliased: false, reason: 'locked' });
  assert.deepEqual(f.labeler.addAlias(9, 3), { aliased: false, reason: 'locked' });
});

test('eligibility is exactly in-person and uploaded recording without CallSid', async () => {
  assert.equal(isEligibleInPersonMeeting({ channel: 'in_person' }), true);
  assert.equal(isEligibleInPersonMeeting({ channel: 'uploaded_recording' }), true);
  for (const meeting of [
    { channel: 'phone' }, { channel: 'rep_phone' }, { channel: 'in_person', call_sid: 'CA123' },
    { channel: 'uploaded_recording', call_sid: 'CA123' }, {},
  ]) assert.equal(isEligibleInPersonMeeting(meeting), false);

  for (const meetingType of ['phone', 'rep_phone', 'browser', 'excluded', undefined]) {
    const f = fixture({ meetingType });
    assert.equal(f.labeler.enabled, false);
    assert.deepEqual(await f.segment(0, "Hi John, this is Gabe."), { enabled: false });
    assert.equal(f.calls.length, 0);
  }
  assert.equal(fixture({ meetingType: 'uploaded_recording' }).labeler.enabled, true);
});

function fakePersistencePool({ locked = false } = {}) {
  const queries = [];
  let inTransaction = false;
  const client = {
    queries, released: false,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      if (sql === 'BEGIN') { inTransaction = true; return { rows: [], rowCount: 0 }; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { inTransaction = false; return { rows: [], rowCount: 0 }; }
      if (String(sql).includes('UPDATE meetings')) return locked
        ? { rows: [], rowCount: 0 }
        : { rows: [{ speaker_labels: { 'Speaker 2': 'John' }, speaker_label_evidence: { 1: { method: 'introduction' } } }], rowCount: 1 };
      if (String(sql).includes('UPDATE transcript_segments')) return { rows: [], rowCount: 3 };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { this.released = true; },
  };
  return { connect: async () => client, client, get inTransaction() { return inTransaction; } };
}

test('persistence relabels prior rows and stores auditable evidence atomically', async () => {
  const pool = fakePersistencePool();
  const result = await persistIntroductionResolution({
    pool, meetingId: 'meeting', speakerIndex: 1, name: 'John',
    evidence: { method: 'introduction', transcript_segment_id: 'seg-1' },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.relabeledCount, 3);
  assert.equal(result.speakerLabels['Speaker 2'], 'John');
  assert.deepEqual(pool.client.queries.map(({ sql }) => sql === 'BEGIN' || sql === 'COMMIT' ? sql : sql.includes('UPDATE meetings') ? 'meeting' : 'segments'), [
    'BEGIN', 'meeting', 'segments', 'COMMIT',
  ]);
  assert.equal(pool.client.released, true);
  assert.equal(pool.inTransaction, false);
});

test('persistence first-writer guard is exactly-once and manual-safe', async () => {
  const pool = fakePersistencePool({ locked: true });
  const result = await persistIntroductionResolution({
    pool, meetingId: 'meeting', speakerIndex: 1, name: 'John', evidence: { method: 'introduction' },
  });
  assert.deepEqual(result, { resolved: false, reason: 'persisted_lock_won', speakerId: 'Speaker 2', relabeledCount: 0 });
  assert.equal(pool.client.queries.some(({ sql }) => sql.includes('UPDATE transcript_segments')), false);
  assert.equal(pool.client.queries.at(-1).sql, 'ROLLBACK');
});
