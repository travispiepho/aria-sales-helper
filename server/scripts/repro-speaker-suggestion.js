/**
 * repro-speaker-suggestion.js
 *
 * Drives the ACTUAL mid-call intro-detection state machine from server.js
 * (copied verbatim from server.js's `isFinal` handler block, same variable
 * names, same constants, same imported isLikelyName/toDisplayName — NOT a
 * reimplementation of the classifier, just the surrounding timer/state glue)
 * against a synthetic sequence of Deepgram-shaped "final" transcript
 * segments, to answer: does `speaker_lock_suggestion` ever get emitted for
 * a realistic mid-call introduction?
 *
 * This is a controlled clock (we pass in `nowMs` explicitly instead of
 * calling Date.now()) so we can simulate real call timing (a customer says
 * "Hi, I'm John" once near call start, doesn't speak again for 40s, etc.)
 * without actually waiting in real time.
 *
 * Run: node scripts/repro-speaker-suggestion.js
 */

import { isLikelyName, toDisplayName } from '../nameHeuristics.js';

// ── Copied constants from server.js (keep in sync manually if changed) ─────
const INTRO_WINDOW_MS = 15000;
const INTRO_SUGGEST_COOLDOWN_MS = 20000;
const INTRO_RE = /\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Za-z][A-Za-z'’-]{1,20})\b/gi;

function makeDetector() {
  const speakerLocks = {};
  const speakerFirstSeen = {};
  const introCandidates = {};
  const rejectedIntroNames = {};
  const pendingIntroSuggestion = {};
  const introSuggestCooldownUntil = {};
  const suggestions = []; // recorded broadcasts, for the test to inspect

  // Verbatim port of server.js's maybeSuggestIntro(si, nowIntro) after the
  // 2026-08-11 fix (shared by the per-segment call site AND the sweep timer).
  function maybeSuggestIntro(si, nowIntro) {
    if (speakerLocks[si]) return;
    const elapsed = nowIntro - (speakerFirstSeen[si] ?? nowIntro);
    const cooldownOk = nowIntro >= (introSuggestCooldownUntil[si] || 0);
    if (
      elapsed >= INTRO_WINDOW_MS &&
      !pendingIntroSuggestion[si] &&
      cooldownOk &&
      introCandidates[si] && introCandidates[si].size > 0
    ) {
      const best = [...introCandidates[si].values()].sort((a, b) => b.count - a.count)[0];
      if (best) {
        pendingIntroSuggestion[si] = best.name.toLowerCase();
        introSuggestCooldownUntil[si] = nowIntro + INTRO_SUGGEST_COOLDOWN_MS;
        suggestions.push({ speakerId: `Speaker ${parseInt(si, 10) + 1}`, name: best.name, atMs: nowIntro });
      }
    }
  }

  // Verbatim glue logic from server.js's per-group intro block, parameterized
  // on an explicit `nowIntro` instead of Date.now(). Now delegates the
  // elapsed-check/emit to maybeSuggestIntro() instead of inlining it.
  function processGroup(si, groupText, nowIntro) {
    si = String(si);
    if (speakerFirstSeen[si] === undefined) speakerFirstSeen[si] = nowIntro;

    if (!speakerLocks[si]) {
      let m;
      INTRO_RE.lastIndex = 0;
      while ((m = INTRO_RE.exec(groupText)) !== null) {
        const raw = m[1];
        if (!isLikelyName(raw)) continue;
        const display = toDisplayName(raw);
        const nameLower = display.toLowerCase();
        if (rejectedIntroNames[si] && rejectedIntroNames[si].has(nameLower)) continue;
        if (!introCandidates[si]) introCandidates[si] = new Map();
        const prev = introCandidates[si].get(nameLower);
        introCandidates[si].set(nameLower, { name: display, count: (prev ? prev.count : 0) + 1 });
      }
      maybeSuggestIntro(si, nowIntro);
    }
  }

  // Simulates the sweep timer: call maybeSuggestIntro for every known speaker
  // slot at a given wall-clock time, with NO new transcript segment involved.
  function sweep(nowMs) {
    for (const si of Object.keys(speakerFirstSeen)) {
      maybeSuggestIntro(si, nowMs);
    }
  }

  return { processGroup, sweep, suggestions, speakerFirstSeen, introCandidates, pendingIntroSuggestion };
}

let pass = 0, fail = 0;
const failures = [];
function assert(desc, cond) {
  if (cond) pass++; else { fail++; failures.push(desc); }
}

// ── Scenario A: realistic call — customer intros once at t=0, keeps talking ─
// periodically (every ~8s) throughout the call, as real calls do.
{
  const d = makeDetector();
  d.processGroup(0, "Hi there, I'm John, thanks for coming out today", 0);
  // Rep (speaker 1) talks in between — irrelevant to speaker 0's clock.
  d.processGroup(0, "yeah no problem at all", 8000);
  d.processGroup(0, "so about the roof", 16000); // first final AFTER the 15s window closes for speaker 0
  assert('Scenario A: suggestion fires when speaker keeps talking after 15s', d.suggestions.length === 1);
  assert('Scenario A: suggested name is John', d.suggestions[0]?.name === 'John');
}

// ── Scenario B (THE ACTUAL BUG — reproduced below WITHOUT the fix's sweep, ──
// then shown FIXED with the sweep). Customer intros ONCE at t=0 and does not
// produce another FINAL segment on that speaker slot again for a long time —
// extremely common in real calls: a customer says "Hi, I'm John" as a
// one-line greeting, then stays quiet (nodding, listening) while the rep
// does the pitch on a DIFFERENT speaker slot. This matches the real prod
// transcripts found in meetings d344ad78-... and aef1531a-... (see report):
// "I'm Gabriel" at t=+4.9s, then Speaker 2 never produces another final
// until long after the window would have closed — every subsequent segment
// is on a different (rep/other) speaker slot.
{
  // WITHOUT the fix (no sweep called) — pre-fix behavior: only processGroup
  // touches speaker 0, and speaker 0 never speaks again, so the elapsed
  // check inside processGroup never re-runs -> suggestion NEVER fires despite
  // 45s having elapsed on a wall clock. This demonstrates the pre-fix bug.
  const dNoSweep = makeDetector();
  dNoSweep.processGroup(0, "Hi there, I'm John", 0);
  dNoSweep.processGroup(1, "yeah no problem, let's get started", 2000);
  dNoSweep.processGroup(1, "so about the roof", 20000);
  dNoSweep.processGroup(1, "here's what we found", 40000);
  // Speaker 0 (the introducer) never speaks again — no sweep => no re-check.
  assert('Scenario B (pre-fix, no sweep): suggestion never fires though 40s elapsed — reproduces reported bug', dNoSweep.suggestions.length === 0);

  // WITH the fix (sweep called periodically, exactly like introSweepTimer in
  // server.js) — same transcript, same speaker-0 silence, but the sweep
  // independently re-checks every known speaker slot on a timer.
  const dWithSweep = makeDetector();
  dWithSweep.processGroup(0, "Hi there, I'm John", 0);
  dWithSweep.processGroup(1, "yeah no problem, let's get started", 2000);
  dWithSweep.sweep(3000);
  dWithSweep.processGroup(1, "so about the roof", 20000);
  dWithSweep.sweep(20000); // this tick is the one that should now fire
  dWithSweep.processGroup(1, "here's what we found", 40000);
  dWithSweep.sweep(40000);
  assert('Scenario B (FIXED, with sweep): suggestion fires from the sweep alone, no same-slot final needed', dWithSweep.suggestions.length === 1);
  assert('Scenario B (FIXED): suggested name is John', dWithSweep.suggestions[0]?.name === 'John');
}

// ── Scenario C: customer intros once and NEVER produces another final for ──
// the rest of the call, but the sweep still fires because it doesn't depend
// on that speaker's own segments at all.
{
  const d = makeDetector();
  d.processGroup(0, "Hi there, I'm John", 0);
  d.sweep(16000); // 16s later, no other activity on speaker 0 at all
  assert('Scenario C (FIXED): suggestion fires from sweep alone even with zero further segments on that speaker', d.suggestions.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('FAILURES:');
  failures.forEach(f => console.log(' -', f));
}
process.exit(fail > 0 ? 1 : 0);
