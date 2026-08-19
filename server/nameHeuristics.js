/**
 * nameHeuristics.js — name-likelihood classifier for mid-call speaker naming.
 *
 * WHY THIS EXISTS
 * ---------------
 * server.js's live-transcript handler tries to auto-label a speaker when it
 * hears a self-introduction ("Hi, I'm John", "This is Sarah"). The original
 * implementation grabbed the very next word after the trigger phrase and
 * treated it as a name unless it happened to be in a tiny hand-picked
 * STOPWORDS set. That blocklist was unbounded whack-a-mole and, crucially,
 * incomplete: "I'm starting this meeting" locked the speaker's name to
 * "Starting" because "starting" was never added to the list (Gabe Bass's
 * exact reported bug).
 *
 * This module replaces the "reject only if in a hand-picked stoplist"
 * approach with a real name-likelihood signal built from two dictionaries:
 *
 *   1. FIRST_NAMES  — 8,422 US SSA-derived English first names
 *                     (@stdlib male + female first-name datasets, extracted
 *                     to data/first-names.json at build time; NO runtime
 *                     stdlib dependency).
 *   2. COMMON_WORDS — ~9,900 most-common English words (google-10000 list,
 *                     data/common-words.json).
 *
 * WHY DICTIONARY, NOT CAPITALIZATION SIGNAL
 * -----------------------------------------
 * The obvious alternative was to trust Deepgram's capitalization (a proper
 * noun like "John" capitalized mid-sentence vs. a common word like
 * "starting" left lowercase). That was investigated and rejected: Deepgram's
 * Nova-3 model (the one this server uses) is documented as "non-formatted",
 * and smart_format's autocasing is explicitly NOT a proper-noun detector —
 * its entity formatting covers dates/times/currency/phone/email/URL, not
 * arbitrary mid-sentence names. Deepgram's own docs show introductions like
 * "my name is Beth" where the name is NOT reliably distinguished by casing
 * from surrounding words. So capitalization is not a dependable signal here;
 * a lexical name/common-word check is far more robust.
 *
 * CLASSIFICATION (isLikelyName), in priority order:
 *   0. Empty / too short / non-alpha            -> NOT a name
 *   1. In HARD_BLOCK (legacy stopwords, kept as -> NOT a name
 *      belt-and-suspenders)
 *   2. In FIRST_NAMES                            -> IS a name
 *      (rescues real names that are ALSO common
 *       English words: John, Mike, Will, Grace,
 *       Mark, Hope, Faith, Rose, ...)
 *   3. In COMMON_WORDS                           -> NOT a name
 *      (rejects "starting", "trying", "going",
 *       "looking", "calling", ... — the actual bug)
 *   4. Otherwise (unknown token, not a common    -> IS a name (lenient)
 *      word)                                        e.g. "Xander", "Gabe",
 *                                                    rare/ethnic names.
 *
 * The tier-4 leniency (accept unknown tokens) is deliberate and safe in this
 * codebase: the caller (server.js) does NOT auto-lock on a positive result
 * anymore. After a 15-second collection window it emits a
 * `speaker_lock_suggestion` and a human confirms/rejects/edits before any
 * lock is committed. So a rare tier-4 false-positive is caught by the human
 * before it can mislabel anyone — whereas a false-NEGATIVE (rejecting a real
 * but obscure name) only means we don't proactively suggest it, and the rep
 * can still label the speaker manually. Optimizing to eliminate the OBVIOUS
 * common-word false-positives (Gabe's complaint) while staying lenient on
 * genuinely unknown tokens is the right trade-off given the confirmation
 * backstop.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSet(relPath) {
  try {
    const arr = JSON.parse(readFileSync(join(__dirname, relPath), 'utf8'));
    return new Set(arr.map((w) => String(w).toLowerCase()));
  } catch (err) {
    // Fail open-but-safe: if a data file is missing/corrupt, an empty set
    // degrades gracefully — FIRST_NAMES empty means we lose the "rescue real
    // names that are common words" tier, COMMON_WORDS empty means we lose the
    // "reject common words" tier. We log loudly so it's noticed, but never
    // throw at import time (that would crash server boot).
    // eslint-disable-next-line no-console
    console.error(`[nameHeuristics] failed to load ${relPath}: ${err.message}`);
    return new Set();
  }
}

const FIRST_NAMES = loadSet('./data/first-names.json');
const COMMON_WORDS = loadSet('./data/common-words.json');

// Legacy hand-picked stopwords, retained as a hard, always-reject tier. These
// are all common-word false positives already seen in production. Kept even
// though most are also in COMMON_WORDS because a couple (e.g. "happy") also
// appear in the first-names dataset, and this guarantees they never slip
// through tier 2. This list is NO LONGER the primary defense — it's a floor.
const HARD_BLOCK = new Set([
  'going', 'not', 'sure', 'here', 'ready', 'sorry', 'fine', 'good',
  'great', 'okay', 'ok', 'trying', 'looking', 'just', 'also', 'still',
  'actually', 'calling', 'gonna', 'kind', 'about', 'done', 'happy',
  // additions observed / anticipated (defense in depth; the dictionary
  // tiers already catch these, but explicit is cheap):
  'starting', 'talking', 'speaking', 'hoping', 'excited', 'glad',
  'thrilled', 'wondering', 'thinking', 'hearing', 'joining', 'meeting',
]);

/**
 * Normalize a raw candidate token to a comparable lowercase form.
 * Strips surrounding punctuation the regex capture might include, keeps
 * internal apostrophes/hyphens (D'Angelo, Mary-Jane).
 */
export function normalizeCandidate(raw) {
  if (raw == null) return '';
  return String(raw)
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z'’-]+$/, '')
    .replace(/’/g, "'")
    .trim();
}

/**
 * Is `raw` likely a real person's first name (as opposed to a common word
 * that merely followed an introduction trigger phrase)?
 *
 * @param {string} raw candidate word captured after "I'm"/"this is"/etc.
 * @returns {boolean}
 */
export function isLikelyName(raw) {
  const w = normalizeCandidate(raw);
  if (!w || w.length < 2) return false;      // tier 0
  if (HARD_BLOCK.has(w)) return false;        // tier 1
  if (FIRST_NAMES.has(w)) return true;        // tier 2
  if (COMMON_WORDS.has(w)) return false;      // tier 3
  return true;                                // tier 4 (lenient, backstopped by popup)
}

/**
 * Format a raw candidate token into a display name ("john" -> "John",
 * "mary-jane" -> "Mary-Jane"). Does NOT validate; call isLikelyName first.
 */
export function toDisplayName(raw) {
  const w = normalizeCandidate(raw);
  if (!w) return '';
  return w
    .split(/([-'])/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('');
}

// Exposed for tests / diagnostics.
export const _internals = { FIRST_NAMES, COMMON_WORDS, HARD_BLOCK };
