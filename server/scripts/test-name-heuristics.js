/**
 * test-name-heuristics.js
 *
 * Direct unit test for nameHeuristics.isLikelyName() — the Part 1 fix for the
 * mid-call speaker-naming false positives (Gabe Bass's "I'm starting this
 * meeting" -> speaker labeled "Starting" bug).
 *
 * Proves the matcher:
 *   (1) REJECTS common words that follow intro trigger phrases (the bug), and
 *   (2) ACCEPTS real first names — including names that are ALSO common English
 *       words (John, Will, Grace, Mark) and rare/unusual names (Xander, Gabe).
 *
 * Also exercises the SAME regex + isLikelyName path server.js uses, against
 * realistic transcript-like sentences, so we're testing the real end-to-end
 * decision, not just isolated words.
 *
 * Run: node scripts/test-name-heuristics.js
 * Exit code 0 = all pass, 1 = any failure.
 */

import { isLikelyName, toDisplayName } from '../nameHeuristics.js';

// The exact regex server.js uses (kept in sync manually — if you change one,
// change both). Global flag so we can scan a whole sentence.
const INTRO_RE = /\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Za-z][A-Za-z'’-]{1,20})\b/gi;

let pass = 0;
let fail = 0;
const failures = [];

function check(desc, got, want) {
  if (got === want) { pass++; }
  else { fail++; failures.push(`${desc}: got ${got}, want ${want}`); }
}

// ── 1) Word-level: should REJECT (common words / the bug) ──────────────────
const REJECT_WORDS = [
  'starting',   // <-- Gabe's exact example
  'trying', 'going', 'here', 'sure', 'ready', 'sorry', 'fine', 'good',
  'great', 'okay', 'ok', 'looking', 'just', 'also', 'still', 'actually',
  'calling', 'gonna', 'kind', 'about', 'done', 'happy', 'talking',
  'speaking', 'wondering', 'thinking', 'joining', 'excited', 'glad',
  'not', 'here', 'good', 'sorry',
];
for (const w of REJECT_WORDS) check(`reject "${w}"`, isLikelyName(w), false);

// ── 2) Word-level: should ACCEPT (real first names) ────────────────────────
const ACCEPT_NAMES = [
  'John', 'Sarah', 'Mike', 'Gabe', 'Troy', 'Dave', 'Lisa', 'Emily', 'James',
  'Robert', 'Michael', 'Jennifer', 'David', 'Mary', 'Jonathan', 'Kevin',
  'Brian', 'Steve', 'Alex', 'Chris', 'Matthew', 'Daniel', 'Andrew', 'Joshua',
  'Nicholas', 'Tyler', 'Ryan', 'Brandon', 'Justin', 'Gabriel',
  // common-word names (must be rescued by the first-names dictionary tier):
  'Will', 'Grace', 'Mark', 'Hope', 'Faith', 'Rose',
  // rare/unusual names (tier-4 lenient accept):
  'Xander', 'Zayn', 'Dax',
];
for (const n of ACCEPT_NAMES) check(`accept "${n}"`, isLikelyName(n), true);

// ── 3) Sentence-level: the real server.js path (regex -> isLikelyName) ──────
// Each case: [sentence, expectedDisplayNameOrNull]
const SENTENCES = [
  ["I'm starting this meeting", null],              // the bug — must NOT produce "Starting"
  ["I am going to share my screen", null],
  ["this is really exciting", null],                 // "really" not a trigger capture? capture = "really" -> reject
  ["okay so I'm just getting set up", null],
  ["Hi, I'm John and I'll be your rep today", 'John'],
  ["My name is Sarah, nice to meet you", 'Sarah'],
  ["this is Mike from the roofing team", 'Mike'],
  ["name's Gabe, I run the sales floor", 'Gabe'],
  ["I'm Xander, thanks for hopping on", 'Xander'],
  ["I'm here to help", null],                        // "here" rejected
  ["I'm not sure what you mean", null],              // "not" rejected
];

for (const [sentence, expected] of SENTENCES) {
  INTRO_RE.lastIndex = 0;
  let firstValidName = null;
  let m;
  while ((m = INTRO_RE.exec(sentence)) !== null) {
    if (isLikelyName(m[1])) { firstValidName = toDisplayName(m[1]); break; }
  }
  check(`sentence "${sentence}"`, firstValidName, expected);
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\nnameHeuristics test: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL PASS ✅ — "starting" and friends rejected; real names accepted.');
process.exit(0);
