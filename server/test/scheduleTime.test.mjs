import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveScheduledTime, SCHEDULE_TIME_ZONE } from '../scheduleTime.js';

test('resolves explicit America/Detroit local time across Eastern offsets', () => {
  assert.equal(resolveScheduledTime('2026-08-29T10:30', SCHEDULE_TIME_ZONE, new Date('2026-08-28T00:00:00Z')).toISOString(), '2026-08-29T14:30:00.000Z');
  assert.equal(resolveScheduledTime('2026-12-10T10:30', SCHEDULE_TIME_ZONE, new Date('2026-08-28T00:00:00Z')).toISOString(), '2026-12-10T15:30:00.000Z');
});

test('rejects past, malformed, wrong timezone, DST gap and DST ambiguity', () => {
  assert.throws(() => resolveScheduledTime('2026-08-28T10:30', SCHEDULE_TIME_ZONE, new Date('2026-08-28T15:00:00Z')), /future/);
  assert.throws(() => resolveScheduledTime('not-a-date', SCHEDULE_TIME_ZONE), /valid/);
  assert.throws(() => resolveScheduledTime('2026-08-29T10:30', 'UTC'), /America\/Detroit/);
  assert.throws(() => resolveScheduledTime('2026-03-08T02:30', SCHEDULE_TIME_ZONE, new Date('2026-01-01T00:00:00Z')), /does not exist/);
  assert.throws(() => resolveScheduledTime('2026-11-01T01:30', SCHEDULE_TIME_ZONE, new Date('2026-01-01T00:00:00Z')), /occurs twice/);
});
