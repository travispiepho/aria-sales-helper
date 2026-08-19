/**
 * objectionDetection.js — ARIA Priority 1 roadmap, item 5 (2026-08-05)
 * "Live rebuttal teleprompter" — detection half.
 *
 * ⚠️ THIS IS A STUB-LEVEL HEURISTIC, NOT A REAL CLASSIFIER. ⚠️
 *
 * Per the task brief: "if full live objection-detection + LLM-generated
 * rebuttal within a tight latency budget is not reasonably buildable in one
 * pass, build the scaffolding... and clearly document what's stubbed vs.
 * real." This module IS that stub — a fast, zero-latency, keyword/pattern
 * match against the prospect's just-finalized transcript segment. It is
 * intentionally simple so it can run synchronously in the hot path of the
 * Deepgram result handler with no added latency of its own; the LLM call
 * for the actual rebuttal TEXT (in coachingAnalysis.js's generateRebuttal())
 * is the part with real latency (a network round-trip to OpenRouter/Claude),
 * which is why detection is kept cheap and instant.
 *
 * WHAT'S REAL: the keyword categories below are drawn from common sales-
 * objection taxonomy (price, timing, trust/competitor, spouse/authority,
 * DIY) and the matching logic genuinely runs against every finalized
 * prospect segment in the live pipeline (see server.js's Deepgram result
 * handler, "suggested_rebuttal" scaffolding block).
 *
 * WHAT'S STUBBED / NOT PRODUCTION-GRADE:
 *   - Pure keyword/regex matching — no ML/NLU, no context window beyond the
 *     single segment, no negation handling ("I'm NOT worried about price"
 *     would still match "price"). Real false-positive rate is unmeasured.
 *   - No de-duplication across a whole call beyond a simple per-category
 *     cooldown (see server.js) — a chatty prospect repeating "expensive"
 *     three times in five minutes will only trigger once per cooldown
 *     window, not per-mention, but this is a blunt instrument, not a
 *     genuine "have we already handled this objection" tracker.
 *   - No confidence score — every match is treated as equally worth
 *     interrupting the rep's live coaching feed with a suggestion.
 *
 * REALISTIC NEXT STEP: replace this with an actual LLM-based classifier
 * call (cheap/fast model, e.g. a single classification call per segment) or
 * a proper trained intent classifier, once real call volume exists to
 * validate false-positive/false-negative rates. Keyword stubs are a
 * reasonable placeholder ONLY because raw regex has effectively zero
 * latency cost, keeping the live pipeline's hot path unaffected while the
 * real detection approach is designed.
 */

const OBJECTION_PATTERNS = [
  {
    category: 'price',
    patterns: [
      /\b(too\s+)?expensive\b/i,
      /\bcan'?t afford\b/i,
      /\bout of (our |my )?budget\b/i,
      /\bthat'?s a lot of money\b/i,
      /\bcheaper (quote|estimate|option)\b/i,
      /\bprice is (too )?high\b/i,
    ],
  },
  {
    category: 'competitor',
    patterns: [
      /\b(other|another) (company|painter|contractor|quote|estimate)\b/i,
      /\b(other|more|some|a few) .*(quotes|estimates|bids)\b/i,
      /\bshop(ping)? around\b/i,
    ],
  },
  {
    category: 'timing',
    patterns: [
      /\bnot (ready|the right time)\b/i,
      /\bneed to (think|wait|sleep on it)\b/i,
      /\b(not (right )?now|ready right now|not the best time)\b/i,
      /\bmaybe (next|later)\b/i,
    ],
  },
  {
    category: 'authority',
    patterns: [
      /\b(need to )?(talk|check|ask) (to|with) my (wife|husband|spouse|partner)\b/i,
      /\bnot my (decision|call) (alone|to make)\b/i,
    ],
  },
  {
    category: 'diy',
    patterns: [
      /\bdo it (myself|ourselves)\b/i,
      /\bDIY\b/,
      /\bmy (brother|cousin|neighbor|friend) .*(paint|do it|handle it)\b/i,
    ],
  },
  {
    category: 'trust',
    patterns: [
      /\bnever heard of (you|certapro)\b/i,
      /\bhow do (i|we) know\b/i,
      /\bwhat if (it goes wrong|something happens|i'?m not happy)\b/i,
    ],
  },
];

/**
 * detectObjection(text) — synchronous, zero-network, cheap pattern match.
 * Returns { category, matchedPattern } on the FIRST matching category, or
 * null if nothing matched. Deliberately returns only the first match (not
 * all matches) to keep downstream handling (one rebuttal suggestion per
 * segment) simple.
 */
function detectObjection(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { category, patterns } of OBJECTION_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { category, matchedPattern: pattern.source };
      }
    }
  }
  return null;
}

export { detectObjection, OBJECTION_PATTERNS };
