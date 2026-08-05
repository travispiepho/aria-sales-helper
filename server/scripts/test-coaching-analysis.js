#!/usr/bin/env node
/**
 * test-coaching-analysis.js — manual test harness for coachingAnalysis.js
 * (ARIA Priority 1 roadmap: BANT, insider-language, question-gaps)
 *
 * Matches this repo's existing test-script convention (plain Node scripts
 * in scripts/, no test framework — see test-audio-codec.js /
 * test-speaker-relabel.js from the 2026-08-04 pyannoteAI/Twilio pass).
 *
 * Two modes:
 *   1. Structural/unit checks on parseJsonLoose() — no network, always runs.
 *   2. Live smoke test against the REAL OpenRouter/Claude pipeline using a
 *      synthetic sample transcript, IF OPENROUTER_API_KEY (or
 *      OPENROUTER_KEY from .env.secrets) is available. This proves the
 *      actual functions produce real, sane output — not just "should work".
 *
 * No production DB is touched. No meeting IDs used are real.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeBant, analyzeInsiderLanguage, analyzeQuestionGaps, generateRebuttal, parseJsonLoose } from '../coachingAnalysis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

// ─── 1. parseJsonLoose unit checks (no network) ─────────────────────────────
console.log('=== parseJsonLoose unit checks ===');
check('plain JSON', JSON.stringify(parseJsonLoose('{"a":1}')) === '{"a":1}');
check('markdown-fenced JSON', JSON.stringify(parseJsonLoose('```json\n{"a":1}\n```')) === '{"a":1}');
check('trailing comma repair', JSON.stringify(parseJsonLoose('{"a":1,}')) === '{"a":1}');
check('unquoted keys repair', JSON.stringify(parseJsonLoose('{a:1}')) === '{"a":1}');
check('array shape', JSON.stringify(parseJsonLoose('{"flags":[{"phrase":"x"}]}')) === '{"flags":[{"phrase":"x"}]}');
check('garbage returns null', parseJsonLoose('not json at all') === null);
check('empty string returns null', parseJsonLoose('') === null);

// ─── 2. Live smoke test (requires a real OpenRouter key) ───────────────────
function loadEnvSecrets() {
  const secretsPath = path.join(__dirname, '..', '..', '..', '.env.secrets');
  try {
    const content = fs.readFileSync(secretsPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const idx = line.indexOf('=');
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {
    // ok if missing
  }
}
loadEnvSecrets();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;

// Synthetic sample transcript: deliberately engineered to contain
//   - clear BANT signal (budget mentioned, decision-maker present, real need,
//     concrete timeline)
//   - one insider/jargon phrase from the rep ("back-rolling", unexplained)
//   - one prospect question the rep talks past (timeline question answered
//     with a primer-quality tangent instead)
const SAMPLE_SEGMENTS = [
  { speaker: 'Rep', text: "Thanks for having me out today. So tell me, what's got you looking at repainting the exterior now?" },
  { speaker: 'Prospect', text: "Well the sun's really faded the south side and we want to sell in about two months, so we need it done soon." },
  { speaker: 'Rep', text: "Got it, so there's a real deadline here. Are you the one making the final call on this, or is your spouse involved too?" },
  { speaker: 'Prospect', text: "It's just me, I handle all this. We've got about eight to ten thousand set aside for it." },
  { speaker: 'Rep', text: "Perfect, that's right in our typical range for a house this size. So how long will the whole job actually take from start to finish?" },
  { speaker: 'Rep', text: "So the primer we use is a high build acrylic, really good stuff, and we'll do proper back-rolling on the siding after we spray it so it lays down even." },
  { speaker: 'Prospect', text: "Okay... but yeah, how many days are we talking, since we're on a timeline here?" },
  { speaker: 'Rep', text: "Right, so once we get started we move fast, typically about a week depending on weather, and we can lock in a start date this week if you're ready to move forward." },
];

async function runLiveSmokeTest() {
  console.log('\n=== Live smoke test (real Claude/OpenRouter call) ===');
  if (!OPENROUTER_API_KEY) {
    console.log('  SKIPPED: no OPENROUTER_API_KEY/OPENROUTER_KEY available in this environment.');
    return;
  }

  const fakeMeetingId = 'test-meeting-not-real';

  console.log('\n-- analyzeBant() --');
  const bant = await analyzeBant(OPENROUTER_API_KEY, fakeMeetingId, SAMPLE_SEGMENTS);
  console.log(JSON.stringify(bant, null, 2));
  check('bant returns object', bant !== null && typeof bant === 'object');
  if (bant) {
    check('budget score in range', bant.budget.score >= 0 && bant.budget.score <= 100);
    check('authority score in range', bant.authority.score >= 0 && bant.authority.score <= 100);
    check('need score in range', bant.need.score >= 0 && bant.need.score <= 100);
    check('timeline score in range', bant.timeline.score >= 0 && bant.timeline.score <= 100);
    check('closing_certainty_pct in range', bant.closing_certainty_pct >= 0 && bant.closing_certainty_pct <= 100);
    // This sample transcript has strong signal on all 4 factors — expect a
    // reasonably high certainty score, not a low/near-zero one.
    check('closing_certainty_pct is reasonably high for strong-signal sample (>50)', bant.closing_certainty_pct > 50);
  }

  console.log('\n-- analyzeInsiderLanguage() --');
  const flags = await analyzeInsiderLanguage(OPENROUTER_API_KEY, fakeMeetingId, SAMPLE_SEGMENTS);
  console.log(JSON.stringify(flags, null, 2));
  check('insider language returns array', Array.isArray(flags));
  check('insider language found at least 1 flag (back-rolling expected)', Array.isArray(flags) && flags.length >= 1);
  if (Array.isArray(flags) && flags.length > 0) {
    check('flag has valid segment_index', flags.every(f => Number.isInteger(f.segment_index) && f.segment_index >= 0 && f.segment_index < SAMPLE_SEGMENTS.length));
    check('flag has non-empty phrase', flags.every(f => f.phrase && f.phrase.length > 0));
  }

  console.log('\n-- analyzeQuestionGaps() --');
  const gaps = await analyzeQuestionGaps(OPENROUTER_API_KEY, fakeMeetingId, SAMPLE_SEGMENTS);
  console.log(JSON.stringify(gaps, null, 2));
  check('question gaps returns array', Array.isArray(gaps));
  check('question gap found at least 1 (timeline question dodged)', Array.isArray(gaps) && gaps.length >= 1);
  if (Array.isArray(gaps) && gaps.length > 0) {
    check('gap has valid question_segment_index', gaps.every(g => Number.isInteger(g.question_segment_index) && g.question_segment_index >= 0 && g.question_segment_index < SAMPLE_SEGMENTS.length));
    check('gap has non-empty question_text', gaps.every(g => g.question_text && g.question_text.length > 0));
  }

  console.log('\n-- generateRebuttal() (item 5: live rebuttal teleprompter, real LLM half) --');
  const rebuttal = await generateRebuttal(
    OPENROUTER_API_KEY,
    fakeMeetingId,
    'price',
    "Honestly that's way too expensive for us right now.",
    SAMPLE_SEGMENTS.slice(-3)
  );
  console.log(JSON.stringify(rebuttal, null, 2));
  check('rebuttal returns a non-empty string', typeof rebuttal === 'string' && rebuttal.length > 0);
  check('rebuttal is reasonably short (teleprompter constraint, <60 words)', typeof rebuttal === 'string' && rebuttal.split(/\s+/).length < 60);
}

await runLiveSmokeTest();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
