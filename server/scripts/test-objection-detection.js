#!/usr/bin/env node
/**
 * test-objection-detection.js — unit tests for objectionDetection.js's STUB
 * keyword matcher (ARIA Priority 1 roadmap, item 5). No network required.
 */
import { detectObjection } from '../objectionDetection.js';

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS: ${label}`); passed++; }
  else { console.log(`  FAIL: ${label}`); failed++; }
}

console.log('=== objectionDetection.detectObjection() ===');

check('price objection detected', detectObjection("Honestly that's way too expensive for us")?.category === 'price');
check('competitor objection detected', detectObjection("We're getting a few other quotes first")?.category === 'competitor');
check('timing objection detected', detectObjection("I don't think we're ready right now")?.category === 'timing');
check('authority objection detected', detectObjection("I need to talk to my wife about this")?.category === 'authority');
check('diy objection detected', detectObjection("My brother could probably do it himself")?.category === 'diy');
check('trust objection detected', detectObjection("How do I know you'll actually show up")?.category === 'trust');
check('neutral statement returns null', detectObjection("Yeah the kitchen is right through there") === null);
check('empty string returns null', detectObjection('') === null);
check('null input returns null', detectObjection(null) === null);
check('undefined input returns null', detectObjection(undefined) === null);
check('non-string input returns null', detectObjection(42) === null);
check('first matching category wins (price checked before others)', detectObjection("That's expensive and I need to check with my spouse")?.category === 'price');

// Known limitation, documented in the module docstring: no negation handling.
// This is intentionally checked here to make the stub's real behavior explicit,
// not to assert it's correct — it's a known false positive by design.
const negationResult = detectObjection("I'm not worried about it being expensive at all");
check('KNOWN LIMITATION: negation not handled (documents stub behavior, not correctness)', negationResult?.category === 'price');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
