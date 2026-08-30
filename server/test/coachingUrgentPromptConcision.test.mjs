import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// server.js starts a live Fastify listener + DB pool at module load time
// (see `await fastify.listen(...)` at the bottom of the file), so it cannot
// be safely `import`-ed from a unit test. Instead we assert directly on the
// COACHING_SYSTEM_PROMPT source text, the same pattern used for other
// prompt-template guarantees in this codebase.

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

function extractUrgentFieldGuidance(src) {
  const match = src.match(/- urgent: ([^\n]+(?:\n(?!- \w+:)[^\n]*)*)/);
  assert.ok(match, 'expected to find the "urgent" FIELD GUIDANCE bullet in COACHING_SYSTEM_PROMPT');
  return match[1];
}

test('urgent-alert prompt guidance caps output at one short, glanceable sentence', () => {
  const urgentGuidance = extractUrgentFieldGuidance(serverSrc);

  // Must explicitly instruct a hard word cap so the model does not drift
  // back into paragraph-length coaching advice.
  assert.match(
    urgentGuidance,
    /\b(\d+)\s+words?\s+or\s+fewer\b/i,
    'urgent field guidance must state an explicit word-count ceiling'
  );

  // Must instruct exactly one sentence, not "1-2 sentences" (the prior,
  // too-wordy guidance that produced paragraph-length alerts reps could
  // not skim mid-call).
  assert.match(
    urgentGuidance,
    /\bone short sentence\b/i,
    'urgent field guidance must ask for a single short sentence'
  );
  assert.doesNotMatch(
    urgentGuidance,
    /1-2 sentences/i,
    'urgent field guidance must not permit multi-sentence output anymore'
  );

  // Must explicitly call out this is read mid-conversation / must be
  // glanceable, to anchor *why* it needs to be short (per Troy/Gabe's ask).
  assert.match(
    urgentGuidance,
    /mid-conversation|glanceable/i,
    'urgent field guidance should explain the live-call skimming constraint'
  );

  // The example alerts embedded in the prompt should themselves model the
  // new short-sentence style (no more double-clause "This X is doing Y —
  // do Z." style paragraphs chained across multiple full sentences).
  const exampleSentences = urgentGuidance.match(/"[^"]+"/g) || [];
  assert.ok(exampleSentences.length >= 2, 'expected multiple worked examples in the urgent guidance');
  for (const example of exampleSentences) {
    const words = example.replace(/["]/g, '').trim().split(/\s+/).filter(Boolean);
    assert.ok(
      words.length <= 12,
      `example "${example}" has ${words.length} words; expected each worked example to fit the new <=12-word cap`
    );
  }
});
