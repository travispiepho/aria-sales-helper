import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTwoPersonIntroduction,
  createInPersonIntroductionLabeler,
  persistIntroductionResolution,
  INTRODUCTION_WINDOW_MS,
} from '../inPersonIntroductionLabels.js';

const positives = [
  ["Hi, I’m Gabe, and this is Sarah.", 'Gabe', 'Sarah', 'this_is'],
  ['My name is Gabe; this is Sarah.', 'Gabe', 'Sarah', 'this_is'],
  ["I’m Gabe with CertaPro, and you’re Sarah, right?", 'Gabe', 'Sarah', 'you_are_right'],
  ["I'm Gabe and I'm here with Sarah.", 'Gabe', 'Sarah', 'here_with'],
  ["Hello! I am D'Angelo; this is Mary-Jane.", "D'Angelo", 'Mary-Jane', 'this_is'],
  ['Hi, I’m José, and this is Zoë.', 'José', 'Zoë', 'this_is'],
];
for (const [phrase, selfName, customerName, pattern] of positives) {
  test(`parser accepts: ${phrase}`, () => {
    assert.deepEqual(parseTwoPersonIntroduction(phrase), {
      selfName, customerName, pattern,
      confidence: pattern === 'you_are_right' ? 0.96 : 0.98,
      evidenceText: phrase,
    });
  });
}

const negatives = [
  "I'm starting this meeting, and this is the agenda.",
  "I'm Gabe, and this is Sarah and John.",
  'This is Sarah.',
  "I'm Gabe with CertaPro.",
  "I'm the painter, and this is the customer.",
  "I'm Gabe, and you're ready, right?",
  "Yesterday I said I'm Gabe and this is Sarah",
  "I'm Gabe and I'm here with the homeowner.",
];
for (const phrase of negatives) {
  test(`parser rejects: ${phrase}`, () => assert.equal(parseTwoPersonIntroduction(phrase), null));
}

function fixture(overrides = {}) {
  const calls = [];
  let clock = 1_000_000;
  const labeler = createInPersonIntroductionLabeler({
    meetingType: 'in_person',
    repDisplayName: 'Gabriel “Gabe” Bass',
    startedAtMs: clock,
    now: () => clock,
    resolveIdentity: async (identity) => { calls.push(identity); return { resolved: true }; },
    ...overrides,
  });
  return {
    labeler,
    calls,
    tick: (ms) => { clock += ms; return clock; },
    segment: (speakerIndex, text, extra = {}) => labeler.onSegment({
      id: extra.id || `seg-${speakerIndex}-${clock}`,
      speakerIndex,
      text,
      ts: new Date(clock).toISOString(),
      timestampMs: clock,
      ...extra,
    }),
  };
}

test('fixture resolves authenticated rep and adjacent responding customer, with auditable evidence', async () => {
  const f = fixture();
  const first = await f.segment(2, "Hi, I'm Gabe, and this is Sarah.", { id: 'intro-1' });
  assert.equal(first.rep.resolved, true);
  assert.equal(first.pendingCustomer, true);
  f.tick(800);
  assert.equal((await f.segment(7, 'Hi, nice to meet you.')).pendingCustomer, true);
  f.tick(300);
  const second = await f.segment(7, 'Yes, Sarah.');
  assert.equal(second.customer.resolved, true);
  assert.deepEqual(f.calls.map(({ speakerIndex, name, role }) => ({ speakerIndex, name, role })), [
    { speakerIndex: 2, name: 'Gabriel “Gabe” Bass', role: 'rep' },
    { speakerIndex: 7, name: 'Sarah', role: 'customer' },
  ]);
  assert.equal(f.calls[0].evidence.transcript_segment_id, 'intro-1');
  assert.equal(f.calls[0].evidence.transcript_text, "Hi, I'm Gabe, and this is Sarah.");
});

test('delayed customer needs two turns when first response is not an acknowledgement', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe and I'm here with Sarah.");
  f.tick(5000);
  assert.equal((await f.segment(4, 'The living room is over here.')).pendingCustomer, true);
  f.tick(1000);
  assert.equal((await f.segment(4, 'Yes, Sarah — we also want the trim painted.')).customer.resolved, true);
  assert.equal(f.calls.at(-1).speakerIndex, 4);
});

test('two arbitrary turns from a rep split do not prove the customer identity', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe, and this is Sarah.");
  f.tick(400);
  await f.segment(3, 'The estimate will cover labor and materials.');
  f.tick(400);
  const result = await f.segment(3, 'I can walk you through the options.');
  assert.equal(result.pendingCustomer, true);
  assert.equal(f.calls.filter(c => c.role === 'customer').length, 0);
});

test('does not pick first other index when multiple diarized speakers respond', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe, and this is Sarah.");
  f.tick(500);
  await f.segment(1, 'The kitchen is through here.');
  f.tick(500);
  const result = await f.segment(2, 'Hello there.');
  assert.equal(result.ambiguous, true);
  assert.equal(f.calls.length, 1);
});

test('authenticated-name conflict labels nobody and reports conflict', async () => {
  const conflicts = [];
  const f = fixture({ onConflict: (value) => conflicts.push(value) });
  const result = await f.segment(0, "I'm Michael, and this is Sarah.");
  assert.equal(result.conflict.reason, 'authenticated_rep_name_conflict');
  assert.equal(f.calls.length, 0);
  assert.equal(conflicts.length, 1);
});

test('manual locks win and are never overwritten', async () => {
  const f = fixture({ existingLocks: { 0: { name: 'Manual Rep', source: 'manual' } } });
  const result = await f.segment(0, "I'm Gabe, and this is Sarah.");
  assert.equal(result.conflict.reason, 'existing_lock_conflict');
  assert.equal(f.calls.length, 0);
});

test('introduction locks block later dedup aliases in both directions', async () => {
  const f = fixture();
  await f.segment(3, "I'm Gabe, and this is Sarah.");
  assert.deepEqual(f.labeler.addAlias(3, 1), { aliased: false, reason: 'locked' });
  assert.deepEqual(f.labeler.addAlias(9, 3), { aliased: false, reason: 'locked' });
  assert.deepEqual(f.labeler.addAlias(9, 8), { aliased: true });
});

test('same introduction is idempotent', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe, and this is Sarah.");
  f.tick(100);
  const repeat = await f.segment(0, "I'm Gabe, and this is Sarah.");
  assert.equal(repeat.rep.reason, 'idempotent');
  assert.equal(f.calls.filter(c => c.role === 'rep').length, 1);
});

test('browser and phone meeting types are hard-disabled', async () => {
  for (const meetingType of ['browser', 'phone']) {
    const calls = [];
    const labeler = createInPersonIntroductionLabeler({
      meetingType,
      repDisplayName: 'Gabe Bass',
      resolveIdentity: async (identity) => calls.push(identity),
    });
    assert.equal(labeler.enabled, false);
    assert.deepEqual(await labeler.onSegment({ speakerIndex: 0, text: "I'm Gabe, and this is Sarah." }), { enabled: false });
    assert.equal(calls.length, 0);
  }
});

test('bounded introduction window ignores late introduction', async () => {
  const f = fixture();
  f.tick(INTRODUCTION_WINDOW_MS + 1);
  assert.deepEqual(await f.segment(0, "I'm Gabe, and this is Sarah."), { enabled: true });
  assert.equal(f.calls.length, 0);
});

test('future rows receive resolved labels through getLock', async () => {
  const f = fixture();
  await f.segment(0, "I'm Gabe, and this is Sarah.");
  f.tick(300);
  await f.segment(1, 'Yes, that is me.');
  f.tick(300);
  await f.segment(1, 'Nice to meet you.');
  assert.equal(f.labeler.getLock(0), 'Gabriel “Gabe” Bass');
  assert.equal(f.labeler.getLock(1), 'Sarah');
});

function fakePersistencePool({ locked = false } = {}) {
  const queries = [];
  let inTransaction = false;
  const client = {
    queries,
    released: false,
    async query(sql, params = []) {
      queries.push({ sql: String(sql), params });
      if (sql === 'BEGIN') { inTransaction = true; return { rows: [], rowCount: 0 }; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { inTransaction = false; return { rows: [], rowCount: 0 }; }
      if (String(sql).includes('UPDATE meetings')) {
        return locked
          ? { rows: [], rowCount: 0 }
          : { rows: [{ speaker_labels: { 'Speaker 2': 'Sarah' }, speaker_label_evidence: { 1: { method: 'introduction' } } }], rowCount: 1 };
      }
      if (String(sql).includes('UPDATE transcript_segments')) return { rows: [], rowCount: 3 };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { this.released = true; },
  };
  return { connect: async () => client, client, get inTransaction() { return inTransaction; } };
}

test('persistence transaction updates labels/evidence and all prior generic rows', async () => {
  const pool = fakePersistencePool();
  const result = await persistIntroductionResolution({
    pool,
    meetingId: 'fixture-meeting',
    speakerIndex: 1,
    name: 'Sarah',
    evidence: { method: 'introduction', transcript_segment_id: 'seg-1', transcript_text: "I'm Gabe, and this is Sarah." },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.relabelledCount ?? result.relabeledCount, 3);
  assert.equal(result.speakerLabels['Speaker 2'], 'Sarah');
  assert.deepEqual(pool.client.queries.map(q => q.sql === 'BEGIN' || q.sql === 'COMMIT' ? q.sql : q.sql.includes('UPDATE meetings') ? 'meeting' : 'segments'), [
    'BEGIN', 'meeting', 'segments', 'COMMIT',
  ]);
  assert.equal(pool.client.released, true);
  assert.equal(pool.inTransaction, false);
});

test('persistence is idempotent and manual/persisted lock wins without row relabel', async () => {
  const pool = fakePersistencePool({ locked: true });
  const result = await persistIntroductionResolution({
    pool, meetingId: 'fixture-meeting', speakerIndex: 1, name: 'Sarah', evidence: { method: 'introduction' },
  });
  assert.deepEqual(result, {
    resolved: false, reason: 'persisted_lock_won', speakerId: 'Speaker 2', relabeledCount: 0,
  });
  assert.equal(pool.client.queries.some(q => q.sql.includes('UPDATE transcript_segments')), false);
  assert.equal(pool.client.queries.at(-1).sql, 'ROLLBACK');
});
