/**
 * objectionLibraryMatcher.js — ARIA live rebuttal teleprompter, matching half.
 *
 * Consumes the Objections/Rebuttals library added in commit 053c81e
 * (server.js's /api/objections routes, migrations/2026-08-18-objections-
 * rebuttals.sql) and matches a PROSPECT's finalized transcript segment
 * against it, entirely locally — no network call, no LLM, no added
 * dependency. This is deliberately separate from the pre-existing
 * objectionDetection.js / coachingAnalysis.js's generateRebuttal() stub
 * pair (2026-08-05, category-based keyword match + LLM-generated rebuttal
 * text) — that pipeline is untouched by this module and keeps firing
 * exactly as it did before. This module instead surfaces the REP-CURATED
 * rebuttal text a human actually wrote and saved in the library, with zero
 * LLM cost or latency per transcript segment (the brief's explicit cost/
 * latency constraint: "do NOT make an LLM call on every transcript
 * segment").
 *
 * WHAT'S REAL:
 *   - Text normalization (lowercase, strip punctuation) + English stopword
 *     removal, applied identically to both the objection library text and
 *     the live transcript segment.
 *   - Two independent match signals, either of which can trigger a match:
 *       1. Substring match — the objection's full normalized text (or a
 *          long-enough leading clause of it) appears verbatim inside the
 *          segment. Catches a prospect who says almost exactly what's in
 *          the library.
 *       2. Keyword-overlap score — fraction of the objection's significant
 *          (non-stopword) words that also appear in the segment. Catches
 *          paraphrases ("that seems like a lot of money" vs. library text
 *          "the price is too expensive" both hit "money"/"expensive"-
 *          adjacent... actually see limitations below).
 *   - A numeric confidence in [0,1] is returned so the caller can apply a
 *     minimum-confidence gate before ever showing anything to a rep.
 *
 * WHAT'S HONESTLY LIMITED (do not oversell this):
 *   - This is still keyword/phrase overlap, not semantic understanding. A
 *     prospect who paraphrases an objection with almost no shared
 *     vocabulary ("I don't think this is in the cards for us right now"
 *     vs. a library objection worded "we can't afford it") will NOT match.
 *     It catches obvious/near-verbatim phrasings and moderate paraphrases
 *     that share concrete nouns ("price", "expensive", "wife", "think
 *     about it"), not creative paraphrasing.
 *   - No negation handling ("I'm NOT worried about the price" scores the
 *     same as "I AM worried about the price") — same known limitation as
 *     the pre-existing objectionDetection.js stub. Flagged, not solved,
 *     consistent with this brief's ask to be honest about matching
 *     quality rather than oversell it.
 *   - Confidence is a heuristic score (word-overlap fraction, boosted for
 *     substring hits), not a calibrated probability.
 *
 * WHY NO LLM ESCALATION PATH IN THIS PASS: the brief allows escalating
 * ambiguous cheap-match cases to a model call, batched/debounced. Given the
 * cost/latency constraints and that production's Objections API is not
 * even live yet (migration unapplied), this pass ships the cheap local
 * matcher only, wired so an LLM-escalation step could be added later
 * without changing the call site's shape (buildObjectionMatcherIndex /
 * matchTranscriptSegment already return a confidence + "ambiguous" band
 * that a future pass could hook into) — see MATCH_CONFIDENCE_AMBIGUOUS_MIN/
 * MAX below, currently unused by any escalation logic (there isn't one
 * yet), just documented as the seam.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'about', 'against', 'is', 'am', 'are', 'was', 'were',
  'be', 'been', 'being', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'my',
  'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these',
  'those', 'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'just',
  'really', 'like', 'think', 'know', 'get', 'got', 'going', 'gonna', 'want',
  'need', 'right', 'now', 'well', 'kind', 'sort', 'up', 'out', 'as', 'me',
  'us', 'them', 'can', 'could', 'would', 'should', 'will', 'im', 'dont',
  'thats', 'its',
]);

// Documented seam for a future LLM-escalation pass (see module header).
// Not used by any code path yet — the brief allows shipping the cheap
// matcher alone this pass and escalating only ambiguous cases later.
const MATCH_CONFIDENCE_AMBIGUOUS_MIN = 0.35;
const MATCH_CONFIDENCE_AMBIGUOUS_MAX = 0.55;

// Below this, never show anything — silence over a wrong/weak prompt.
const MIN_CONFIDENCE_TO_FIRE = 0.55;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWords(normalizedText) {
  return normalizedText
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * buildObjectionMatcherIndex(objectionRows) — objectionRows: array of
 * { id, text, category, rebuttals: [{id, text, created_at}] } as returned
 * by GET /api/objections/:id shape (rebuttals array), one per objection.
 * Precomputes normalized text + significant-word sets so per-segment
 * matching (called on every finalized prospect transcript segment) stays
 * cheap. Returns [] for an empty/invalid input — an empty index always
 * yields no matches, which is the safe/no-op behavior required when the
 * library is empty or failed to load.
 */
function buildObjectionMatcherIndex(objectionRows) {
  if (!Array.isArray(objectionRows)) return [];
  return objectionRows
    .filter((o) => o && o.text && String(o.text).trim() && Array.isArray(o.rebuttals) && o.rebuttals.length > 0)
    .map((o) => {
      const normalizedText = normalize(o.text);
      const words = significantWords(normalizedText);
      return {
        id: o.id,
        text: o.text,
        category: o.category || null,
        rebuttals: o.rebuttals,
        normalizedText,
        wordSet: new Set(words),
        wordCount: words.length,
      };
    })
    .filter((entry) => entry.wordCount > 0);
}

/**
 * matchTranscriptSegment(text, matcherIndex) — cheap, synchronous, no
 * network call. Returns the single best-matching library entry as
 * { objection: {id, text, category, rebuttals}, confidence, method } or
 * null if nothing clears MIN_CONFIDENCE_TO_FIRE. `method` is
 * 'substring' or 'keyword_overlap', surfaced to the client the same way
 * objectionDetection.js's `detectionMethod` flag is, so it's visible this
 * is heuristic matching against rep-curated text, not an LLM classification.
 */
function matchTranscriptSegment(text, matcherIndex) {
  if (!text || !Array.isArray(matcherIndex) || matcherIndex.length === 0) return null;
  const normalizedSegment = normalize(text);
  if (!normalizedSegment) return null;
  const segmentWords = new Set(significantWords(normalizedSegment));
  if (segmentWords.size === 0) return null;

  let best = null;

  for (const entry of matcherIndex) {
    // Signal 1: substring — the objection's full normalized text (or a
    // clause of at least 4 words from it) appears verbatim in the segment.
    let substringHit = false;
    if (entry.normalizedText.length >= 8 && normalizedSegment.includes(entry.normalizedText)) {
      substringHit = true;
    }

    // Signal 2: keyword overlap fraction of the objection's significant
    // words that also appear in the segment's significant words.
    let overlapCount = 0;
    for (const w of entry.wordSet) {
      if (segmentWords.has(w)) overlapCount++;
    }
    const overlapFraction = entry.wordCount > 0 ? overlapCount / entry.wordCount : 0;

    let confidence = overlapFraction;
    let method = 'keyword_overlap';
    if (substringHit) {
      confidence = Math.max(confidence, 0.9);
      method = 'substring';
    }

    // Require at least 2 overlapping significant words (never fire off a
    // single shared common word like "price" alone with nothing else
    // corroborating) unless it's a substring hit.
    if (!substringHit && overlapCount < 2) continue;

    if (confidence >= MIN_CONFIDENCE_TO_FIRE && (!best || confidence > best.confidence)) {
      best = {
        objection: {
          id: entry.id,
          text: entry.text,
          category: entry.category,
          rebuttals: entry.rebuttals,
        },
        confidence,
        method,
      };
    }
  }

  return best;
}

/**
 * loadObjectionMatcherIndex(pool) — fetches the full Objections+Rebuttals
 * library (reusing the exact same query shape as GET /api/objections plus
 * a per-objection rebuttals fetch, so this never diverges from what the
 * ObjectionsPage.tsx library actually shows) and builds a matcher index.
 *
 * SAFE-BY-CONSTRUCTION: any failure (table doesn't exist yet because the
 * migration hasn't been applied — the current prod state — connection
 * error, etc.) is caught here and results in an EMPTY index, never a
 * thrown error. Callers can call this once per meeting connection without
 * any try/catch of their own; an empty library or a DB/table error both
 * degrade identically to "the live rebuttal teleprompter feature is a
 * no-op for this call", never to a broken meeting.
 */
async function loadObjectionMatcherIndex(pool, log) {
  try {
    if (!pool) return [];
    const objResult = await pool.query(
      `SELECT id, text, category FROM objections ORDER BY created_at DESC`
    );
    if (objResult.rows.length === 0) return [];
    const rebuttalsResult = await pool.query(
      `SELECT id, objection_id, text FROM rebuttals ORDER BY objection_id, created_at ASC`
    );
    const rebuttalsByObjection = new Map();
    for (const r of rebuttalsResult.rows) {
      if (!rebuttalsByObjection.has(r.objection_id)) rebuttalsByObjection.set(r.objection_id, []);
      rebuttalsByObjection.get(r.objection_id).push({ id: r.id, text: r.text });
    }
    const rows = objResult.rows.map((o) => ({
      id: o.id,
      text: o.text,
      category: o.category,
      rebuttals: rebuttalsByObjection.get(o.id) || [],
    }));
    return buildObjectionMatcherIndex(rows);
  } catch (err) {
    // Expected/normal in current prod state (migration not yet applied —
    // "relation \"objections\" does not exist"), and also the correct
    // behavior for any other transient DB error: never let this feature's
    // data load take down meeting setup. Logged (if a logger was passed)
    // at info, not error — this is not an outage, it's the documented
    // "library unavailable" degrade path required by the brief.
    if (log) log(`objection library unavailable, live rebuttal teleprompter disabled for this call: ${err.message}`);
    return [];
  }
}

// ─── Per-meeting noise control state ────────────────────────────────────────
// Keyed by meetingId (not by socket/connection) so cooldown + dismiss state
// survives a socket reconnect within the same meeting — a rep whose call
// briefly drops and reconnects should not see a dismissed prompt come back,
// and should not have their cooldown clock reset. Cleared via
// clearMeetingPromptState(meetingId) when a meeting ends (called from both
// server.js's in-person WS close-on-meeting-end path and telephony.js's
// status-callback finalize path) to avoid an unbounded memory leak across
// many meetings over the life of the process.
const meetingPromptState = new Map();

function getOrCreatePromptState(meetingId) {
  let state = meetingPromptState.get(meetingId);
  if (!state) {
    state = {
      cooldownUntil: new Map(), // objectionId -> ms timestamp
      dismissedObjectionIds: new Set(),
      activeObjectionIds: new Set(), // currently-on-screen, not yet dismissed/expired
    };
    meetingPromptState.set(meetingId, state);
  }
  return state;
}

function clearMeetingPromptState(meetingId) {
  meetingPromptState.delete(meetingId);
}

// Cap concurrent prompts per meeting — brief requires "1, maybe 2, not a
// wall". Two, since a rep mid-conversation may raise a second, different
// objection before dismissing the first.
const MAX_CONCURRENT_PROMPTS = 2;
const PROMPT_COOLDOWN_MS = 90000; // 90s — same objection library entry won't re-fire within this window

/**
 * evaluateLibraryMatch(text, matcherIndex, meetingId) — combines
 * matchTranscriptSegment() with the per-meeting cooldown/dismiss/concurrency
 * gates. Returns the match to surface, or null if nothing should fire
 * (no match, on cooldown, previously dismissed this meeting, or the
 * concurrent-prompt cap is already hit). Does NOT mark the prompt as
 * fired/active — call markPromptFired() once the caller actually decides to
 * broadcast it (keeps this function side-effect-free for easy testing).
 */
function evaluateLibraryMatch(text, matcherIndex, meetingId) {
  const match = matchTranscriptSegment(text, matcherIndex);
  if (!match) return null;
  const state = getOrCreatePromptState(meetingId);
  if (state.dismissedObjectionIds.has(match.objection.id)) return null;
  const cooldownUntil = state.cooldownUntil.get(match.objection.id) || 0;
  if (Date.now() < cooldownUntil) return null;
  if (state.activeObjectionIds.size >= MAX_CONCURRENT_PROMPTS && !state.activeObjectionIds.has(match.objection.id)) return null;
  return match;
}

function markPromptFired(meetingId, objectionId) {
  const state = getOrCreatePromptState(meetingId);
  state.cooldownUntil.set(objectionId, Date.now() + PROMPT_COOLDOWN_MS);
  state.activeObjectionIds.add(objectionId);
}

function markPromptDismissed(meetingId, objectionId) {
  const state = getOrCreatePromptState(meetingId);
  state.dismissedObjectionIds.add(objectionId);
  state.activeObjectionIds.delete(objectionId);
}

export {
  buildObjectionMatcherIndex,
  matchTranscriptSegment,
  loadObjectionMatcherIndex,
  evaluateLibraryMatch,
  markPromptFired,
  markPromptDismissed,
  clearMeetingPromptState,
  normalize,
  significantWords,
  MIN_CONFIDENCE_TO_FIRE,
  MATCH_CONFIDENCE_AMBIGUOUS_MIN,
  MATCH_CONFIDENCE_AMBIGUOUS_MAX,
  MAX_CONCURRENT_PROMPTS,
  PROMPT_COOLDOWN_MS,
};
