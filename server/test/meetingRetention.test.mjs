import assert from 'node:assert/strict';
import test from 'node:test';
import { canDespawnMeeting, RETENTION_WINDOW_MS } from '../meetingRetention.js';

const NOW = new Date('2026-08-30T12:00:00Z');

test('not-yet-24h + not-finished (active, started) is NOT despawnable', () => {
  const meeting = {
    status: 'active',
    started_at: new Date(NOW.getTime() - (RETENTION_WINDOW_MS - 60_000)).toISOString(), // 23h59m ago
    scheduled_for: null,
    scheduled_started_at: null,
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), false);
});

test('24h+ elapsed since logged meeting time is despawnable even if still active', () => {
  const meeting = {
    status: 'active',
    started_at: new Date(NOW.getTime() - (RETENTION_WINDOW_MS + 60_000)).toISOString(), // 24h01m ago
    scheduled_for: null,
    scheduled_started_at: null,
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), true);
});

test('started AND finished before 24h elapsed is despawnable (OR semantics)', () => {
  const meeting = {
    status: 'completed',
    started_at: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    scheduled_for: null,
    scheduled_started_at: null,
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), true);
});

test('not-yet-started scheduled meeting inside the 24h window is NOT despawnable', () => {
  // scheduled_for is in the future relative to NOW, scheduled_started_at is
  // still null (rep hasn't tapped "start" yet) — well inside 24h.
  const scheduledFor = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(); // 1h from now
  const meeting = {
    status: 'active',
    started_at: scheduledFor, // seeded with scheduled_for per scheduledMeetings.js INSERT
    scheduled_for: scheduledFor,
    scheduled_started_at: null,
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), false);
});

test('scheduled meeting cancelled before ever being started still needs the full 24h (never "started")', () => {
  const meeting = {
    status: 'cancelled',
    started_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // scheduled 1h before now, then cancelled
    scheduled_for: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    scheduled_started_at: null, // never actually started
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), false);
});

test('scheduled meeting that was started AND finished is despawnable under the OR interpretation', () => {
  const meeting = {
    status: 'completed',
    started_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
    scheduled_for: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    scheduled_started_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), true);
});

test('exactly at the 24h boundary is despawnable (>=, not >)', () => {
  const meeting = {
    status: 'active',
    started_at: new Date(NOW.getTime() - RETENTION_WINDOW_MS).toISOString(),
    scheduled_for: null,
    scheduled_started_at: null,
  };
  assert.equal(canDespawnMeeting(meeting, { now: NOW }), true);
});

test('missing/null meeting or missing logged time is conservatively NOT despawnable', () => {
  assert.equal(canDespawnMeeting(null, { now: NOW }), false);
  assert.equal(canDespawnMeeting({ status: 'active', started_at: null, scheduled_for: null, scheduled_started_at: null }, { now: NOW }), false);
});
