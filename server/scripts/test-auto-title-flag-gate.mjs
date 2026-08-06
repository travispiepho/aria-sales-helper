/**
 * test-auto-title-flag-gate.mjs — proves the ENABLE_AUTO_TITLE_GENERATION
 * feature-flag gate added 2026-08-05 to generateAutoTitleForMeeting() in
 * server.js actually works BOTH ways, using the REAL shipped function
 * source (extracted directly from server.js, not a hand-retyped copy), so
 * this test can't drift from what's actually deployed.
 *
 * Test 1 (flag unset/false — the prod-deploy state): calls the function
 * with mocked pool.query/fetch/anthropic that would loudly fail the test
 * if called. Asserts:
 *   - function returns null
 *   - pool.query was NEVER called (proves no DB read even happens)
 *   - fetch was NEVER called (proves no OpenRouter/Anthropic network call)
 *
 * Test 2 (flag = 'true' — local-only, never set this way on Railway):
 * same mocks, but fetch is stubbed to return a fake successful title
 * completion instead of throwing. Asserts:
 *   - fetch WAS called (proves the gate, once open, correctly reaches the
 *     real generation call path)
 *   - pool.query WAS called with an UPDATE ... auto_titled = true statement
 *   - function returns the (mock) generated title text
 *
 * This does not hit any real API or real DB — it is pure local proof that
 * the flag branches correctly in the exact code we're shipping.
 *
 * Run: node scripts/test-auto-title-flag-gate.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

// Extract the generateAutoTitleForMeeting function body verbatim from the
// real server.js source by brace-balancing from its declaration.
const startMarker = 'async function generateAutoTitleForMeeting(meetingId) {';
const startIdx = serverSrc.indexOf(startMarker);
if (startIdx === -1) {
  console.error('FAIL: could not find generateAutoTitleForMeeting() in server.js — has it been renamed/moved?');
  process.exit(1);
}
let depth = 0;
let i = startIdx + startMarker.length - 1; // position of the opening '{'
let endIdx = -1;
for (; i < serverSrc.length; i++) {
  if (serverSrc[i] === '{') depth++;
  else if (serverSrc[i] === '}') {
    depth--;
    if (depth === 0) { endIdx = i + 1; break; }
  }
}
if (endIdx === -1) {
  console.error('FAIL: could not brace-balance generateAutoTitleForMeeting() — extraction bug in this test.');
  process.exit(1);
}
const fnSource = serverSrc.slice(startIdx, endIdx);

if (!fnSource.includes('ENABLE_AUTO_TITLE_GENERATION')) {
  console.error('FAIL: extracted function source does NOT reference ENABLE_AUTO_TITLE_GENERATION — the gate is missing from the real shipped code!');
  process.exit(1);
}

console.log('Extracted real generateAutoTitleForMeeting() source from server.js (', fnSource.length, 'chars ), gate present. Running both branches...\n');

async function runScenario(envValue, fetchImpl) {
  const calls = { poolQuery: 0, fetch: 0 };
  const pool = {
    query: async (sql, params) => {
      calls.poolQuery++;
      if (/SELECT speaker, text FROM transcript_segments/.test(sql)) {
        // Enough fake segments to pass the `segments.length < 3` bail-out.
        return { rows: [
          { speaker: 'rep', text: 'So tell me about your current flooring situation.' },
          { speaker: 'customer', text: 'We have hardwood that is scratched up pretty bad.' },
          { speaker: 'rep', text: 'Got it, let me put together a refinish quote for you.' },
        ] };
      }
      if (/UPDATE meetings SET title/.test(sql)) {
        return { rows: [{ id: params[1], title: params[0], auto_titled: true }] };
      }
      return { rows: [] };
    },
  };
  const fastify = { log: { info: () => {}, error: () => {} } };
  const ANTHROPIC_API_KEY = null; // force the OpenRouter branch
  const OPENROUTER_API_KEY = 'fake-test-key-not-real';
  const anthropic = null;
  const fetch = async (...args) => { calls.fetch++; return fetchImpl(...args); };

  if (envValue === undefined) delete process.env.ENABLE_AUTO_TITLE_GENERATION;
  else process.env.ENABLE_AUTO_TITLE_GENERATION = envValue;

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'pool', 'fastify', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'anthropic', 'fetch',
    `return (async () => { ${fnSource}; return generateAutoTitleForMeeting; })();`
  );
  const generateAutoTitleForMeeting = await factory(pool, fastify, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, anthropic, fetch);
  const result = await generateAutoTitleForMeeting('test-meeting-id-0000');
  return { result, calls };
}

let failures = 0;

// ── Test 1: flag unset (the actual prod-deploy state) ──────────────────────
{
  const fetchThatShouldNeverFire = async () => {
    throw new Error('TEST FAILURE: fetch() was called even though ENABLE_AUTO_TITLE_GENERATION is unset — flag is NOT gating the generation call!');
  };
  const { result, calls } = await runScenario(undefined, fetchThatShouldNeverFire);
  const ok = result === null && calls.fetch === 0 && calls.poolQuery === 0;
  console.log(`Test 1 (flag UNSET): result=${JSON.stringify(result)} fetchCalls=${calls.fetch} poolQueryCalls=${calls.poolQuery} ->`, ok ? 'PASS' : 'FAIL');
  if (!ok) failures++;
}

// ── Test 2: flag explicitly 'false' (defensive — also must stay off) ───────
{
  const fetchThatShouldNeverFire = async () => {
    throw new Error('TEST FAILURE: fetch() was called with ENABLE_AUTO_TITLE_GENERATION=false — flag is NOT gating the generation call!');
  };
  const { result, calls } = await runScenario('false', fetchThatShouldNeverFire);
  const ok = result === null && calls.fetch === 0 && calls.poolQuery === 0;
  console.log(`Test 2 (flag='false'): result=${JSON.stringify(result)} fetchCalls=${calls.fetch} poolQueryCalls=${calls.poolQuery} ->`, ok ? 'PASS' : 'FAIL');
  if (!ok) failures++;
}

// ── Test 3: flag='true' (local-only proof the switch also works ON) ────────
{
  const fakeOpenRouterResponse = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Flooring refinish estimate call' } }] }),
  };
  const fetchMock = async () => fakeOpenRouterResponse;
  const { result, calls } = await runScenario('true', fetchMock);
  const ok = result === 'Flooring refinish estimate call' && calls.fetch === 1 && calls.poolQuery === 2;
  console.log(`Test 3 (flag='true', LOCAL ONLY): result=${JSON.stringify(result)} fetchCalls=${calls.fetch} poolQueryCalls=${calls.poolQuery} ->`, ok ? 'PASS' : 'FAIL');
  if (!ok) failures++;
}

delete process.env.ENABLE_AUTO_TITLE_GENERATION;

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
