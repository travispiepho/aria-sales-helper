/**
 * readinessTracker.test.mjs — deterministic unit test for the debounced
 * readiness state machine (server/readinessTracker.js), using an injected
 * fake clock (not real setTimeout) so it's fast and reproducible.
 *
 * This is the STATICALLY TRACED / fast layer. The real anti-flap proof
 * against a genuine blocking event loop (not a fake clock) is a separate,
 * behavioral, real-process test — see the verification report for those
 * runs against an actual `node server.js` process with real HTTP requests.
 *
 * Run: node server/test/readinessTracker.test.mjs
 */
import assert from 'node:assert/strict';
import { createReadinessTracker } from '../readinessTracker.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(err);
  }
}

console.log('readinessTracker.test.mjs');

test('starts ready', () => {
  const t = createReadinessTracker({ now: () => 0 });
  assert.equal(t.isReady(), true);
});

test('a single degraded sample does NOT flip ready -> not ready', () => {
  let clock = 0;
  const t = createReadinessTracker({ degradedSustainMs: 10000, now: () => clock });
  t.sample(true); // one degraded sample
  assert.equal(t.isReady(), true, 'one degraded sample must not trip readiness');
});

test('degraded sustained for exactly the window flips to not ready', () => {
  let clock = 0;
  const t = createReadinessTracker({ degradedSustainMs: 10000, now: () => clock });
  t.sample(true); // clock=0, candidateSince=0
  clock = 5000;
  t.sample(true); // still within window
  assert.equal(t.isReady(), true, 'must still be ready before sustain window elapses');
  clock = 10000;
  t.sample(true); // now elapsed >= 10000ms uninterrupted
  assert.equal(t.isReady(), false, 'must flip not-ready once sustained for >= window');
});

test('a healthy sample in the middle RESETS the degraded-sustain clock (anti-flap)', () => {
  let clock = 0;
  const t = createReadinessTracker({ degradedSustainMs: 10000, now: () => clock });
  t.sample(true); // clock=0
  clock = 9000;
  t.sample(true); // still degraded, 9s in — one healthy blip below should reset this
  clock = 9500;
  t.sample(false); // healthy sample resets candidateSince
  clock = 9600;
  t.sample(true); // degraded again, but candidateSince is now 9500-ish, not 0
  assert.equal(t.isReady(), true, 'a healthy sample must reset the sustain clock, not just pause it');
  clock = 9600 + 10000;
  t.sample(true);
  assert.equal(t.isReady(), false, 'after a fresh full sustain window post-reset, must flip not-ready');
});

test('recovery requires its own sustained healthy window before flipping back to ready', () => {
  let clock = 0;
  const t = createReadinessTracker({ degradedSustainMs: 1000, recoverySustainMs: 5000, now: () => clock });
  t.sample(true);
  clock = 1000;
  t.sample(true);
  assert.equal(t.isReady(), false, 'precondition: must be not-ready before testing recovery');

  clock = 1100;
  t.sample(false); // healthy, but recovery window not elapsed yet
  assert.equal(t.isReady(), false, 'must not flip ready before recovery window elapses');

  clock = 1100 + 5000;
  t.sample(false);
  assert.equal(t.isReady(), true, 'must flip ready once recovery window elapses uninterrupted');
});

test('a single degraded sample during recovery resets the recovery clock', () => {
  let clock = 0;
  const t = createReadinessTracker({ degradedSustainMs: 1000, recoverySustainMs: 5000, now: () => clock });
  t.sample(true);
  clock = 1000;
  t.sample(true); // not ready now
  clock = 2000;
  t.sample(false); // recovering, 1s in
  clock = 6000;
  t.sample(false); // 5s of healthy since clock=2000... wait this is 4000ms, not yet
  assert.equal(t.isReady(), false, 'must not be ready before full recovery window from the reset point');
  clock = 6500;
  t.sample(true); // one degraded sample resets recovery clock (candidateSince cleared to null)
  clock = 6600;
  t.sample(false); // first healthy sample AFTER the reset — this is when the recovery clock actually restarts (candidateSince = 6600)
  clock = 6600 + 4000;
  t.sample(false); // only 4s since restart — not yet the full window
  assert.equal(t.isReady(), false, 'must not flip ready before a full recovery window measured from the post-reset restart point');
  clock = 6600 + 5000;
  t.sample(false); // exactly 5s since restart — window satisfied
  assert.equal(t.isReady(), true, 'must flip ready once a full 5s of uninterrupted healthy has elapsed since the post-reset restart point');
});

test('getState exposes ready flag and configured windows', () => {
  const t = createReadinessTracker({ degradedSustainMs: 1234, recoverySustainMs: 5678, now: () => 0 });
  const s = t.getState();
  assert.equal(s.ready, true);
  assert.equal(s.degradedSustainMs, 1234);
  assert.equal(s.recoverySustainMs, 5678);
});

console.log('');
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All readinessTracker tests passed.');
}
