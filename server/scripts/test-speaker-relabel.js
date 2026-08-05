#!/usr/bin/env node
/**
 * test-speaker-relabel.js — standalone unit test for speakerRelabel.js's
 * provisional-slot -> resolved-identity state machine. Plain Node script
 * (no test framework present in this repo), run via
 * `node scripts/test-speaker-relabel.js`.
 */

import {
  createSpeakerSession,
  appendLine,
  resolveSpeaker,
  isResolved,
  getDisplayName,
  getTranscript,
} from '../speakerRelabel.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
}

// ─── Scenario 1: speaker introduces themselves mid-conversation ──────────
// Prior anonymous-labeled lines should be relabeled once identity resolves.
{
  const session = createSpeakerSession();
  appendLine(session, 'SPEAKER_00', "Hey, how's it going?");
  appendLine(session, 'SPEAKER_01', "Pretty good, thanks for coming out.");
  appendLine(session, 'SPEAKER_00', "So tell me about the project.");
  appendLine(session, 'SPEAKER_01', "Sure, I'm John by the way.");

  // Before resolution: everyone is a generic "Speaker SPEAKER_XX" label.
  const before = getTranscript(session);
  assert(before[1].speaker === 'Speaker SPEAKER_01', 'pre-resolution line carries generic speaker label');
  assert(before[3].speaker === 'Speaker SPEAKER_01', 'pre-resolution self-intro line also carries generic label before resolve');

  const result = resolveSpeaker(session, 'SPEAKER_01', 'John');
  assert(result.resolved === true, 'resolveSpeaker succeeds for a fresh slot');
  assert(result.relabeledCount === 2, `relabeledCount reflects both prior SPEAKER_01 lines (got ${result.relabeledCount})`);

  const after = getTranscript(session);
  assert(after[1].speaker === 'John', 'first prior SPEAKER_01 line is relabeled to John');
  assert(after[3].speaker === 'John', 'self-intro line itself is also relabeled to John');
  assert(after[0].speaker === 'Speaker SPEAKER_00', 'unrelated SPEAKER_00 line is untouched');
  assert(after[2].speaker === 'Speaker SPEAKER_00', 'unrelated SPEAKER_00 line is untouched (2nd instance)');

  // Future lines for the resolved slot use the name directly.
  const newLine = appendLine(session, 'SPEAKER_01', "Anyway, as I was saying...");
  assert(newLine.speaker === 'John', 'lines appended after resolution use the resolved name immediately');
  assert(isResolved(session, 'SPEAKER_01') === true, 'isResolved reflects resolved state');
  assert(isResolved(session, 'SPEAKER_00') === false, 'isResolved is false for a still-unresolved slot');
}

// ─── Scenario 2: two speakers, both eventually resolve, independently ────
{
  const session = createSpeakerSession();
  appendLine(session, '0', 'Hi there.');
  appendLine(session, '1', 'Hello!');
  appendLine(session, '0', 'This is Sarah from CertaPro.');
  appendLine(session, '1', 'Nice to meet you, this is Mike.');

  resolveSpeaker(session, '0', 'Sarah');
  resolveSpeaker(session, '1', 'Mike');

  const t = getTranscript(session);
  assert(t.every((l, i) => l.speaker === (i % 2 === 0 ? 'Sarah' : 'Mike')),
    'both speakers correctly relabeled across their own respective lines only');
}

// ─── Scenario 3: resolving an already-resolved slot without force is a
// no-op (first resolution wins) ────────────────────────────────────────────
{
  const session = createSpeakerSession();
  appendLine(session, 'A', 'line 1');
  resolveSpeaker(session, 'A', 'Alice');
  appendLine(session, 'A', 'line 2');

  const secondAttempt = resolveSpeaker(session, 'A', 'Alicia'); // wrong/duplicate resolve attempt
  assert(secondAttempt.resolved === false, 'second resolveSpeaker call without force is rejected');
  assert(secondAttempt.previousName === 'Alice', 'rejected resolve reports the existing name');
  assert(getDisplayName(session, 'A') === 'Alice', 'name remains the first-resolved value after a rejected second attempt');
}

// ─── Scenario 4: force=true allows drift-correction (re-resolve) ─────────
{
  const session = createSpeakerSession();
  appendLine(session, 'A', 'line 1');
  resolveSpeaker(session, 'A', 'WrongName');
  appendLine(session, 'A', 'line 2'); // appended while resolved as "WrongName"

  const corrected = resolveSpeaker(session, 'A', 'CorrectName', { force: true });
  assert(corrected.resolved === true, 'force:true allows re-resolving an already-resolved slot');
  assert(corrected.previousName === 'WrongName', 'force resolution reports the prior (incorrect) name');
  assert(getDisplayName(session, 'A') === 'CorrectName', 'display name reflects the corrected identity after force-resolve');

  // speakerRelabel tracks EVERY line ever tagged under a raw slot (not just
  // pre-first-resolution ones), specifically so a force-correction can walk
  // back and fix lines emitted under a prior INCORRECT resolution too --
  // both line 1 (emitted before any resolution) and line 2 (emitted while
  // "WrongName" was incorrectly locked in) should end up corrected.
  const t = getTranscript(session);
  assert(t[0].speaker === 'CorrectName', 'line appended before first resolve ends up correctly labeled after the force-correction');
  assert(t[1].speaker === 'CorrectName', 'line appended while the (incorrect) first resolution was active is ALSO corrected by the later force-resolve -- this is the whole point of drift-correction');
  assert(corrected.relabeledCount === 2, `force-correction relabeledCount reflects both the pre-resolution line and the wrongly-locked line (got ${corrected.relabeledCount})`);
}

// ─── Scenario 5: unresolved slot mid-call, then never resolves (no crash,
// stays generic) ───────────────────────────────────────────────────────────
{
  const session = createSpeakerSession();
  appendLine(session, 'X', 'never introduces themselves');
  appendLine(session, 'X', 'still anonymous');
  const t = getTranscript(session);
  assert(t.every(l => l.speaker === 'Speaker X'), 'an unresolved slot stays generically labeled indefinitely without error');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All speakerRelabel tests PASSED');
  process.exit(0);
}
