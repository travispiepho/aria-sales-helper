/**
 * coachingAnalysis.js — ARIA Priority 1 roadmap (2026-08-05)
 *
 * Post-meeting LLM analysis for three roadmap items, all routed through the
 * SAME Claude-via-OpenRouter pipeline already used by server.js's
 * runCoachingAnalysis()/summary endpoint (model: anthropic/claude-haiku-4-5,
 * same OpenRouter base URL / headers convention). No new AI provider is
 * introduced.
 *
 *   1. BANT + closing certainty %      -> analyzeBant()
 *   3. Insider-language flagger        -> analyzeInsiderLanguage()
 *   4. Question-listening gaps         -> analyzeQuestionGaps()
 *
 * Item 2 (TEPIT) is explicitly out of scope for this pass — not defined,
 * not touched, per task instructions.
 *
 * Item 6 (coaching reports) has NO analysis logic of its own — it is a
 * pure aggregation of this module's stored results + existing
 * coaching_snapshots/analytics data. See server.js's
 * GET /api/meetings/:id/coaching-report.
 *
 * All three functions:
 *   - Take (openrouterApiKey, meetingId, segments) where `segments` is the
 *     already-fetched transcript_segments rows (speaker, text, ts) — no
 *     redundant DB fetch inside this module.
 *   - Return null (not throw) on missing API key / empty transcript / LLM
 *     failure, matching the existing runCoachingAnalysis() null-on-failure
 *     convention in server.js, so callers can 503 cleanly.
 *   - Do NOT persist to the DB themselves — server.js's route handlers own
 *     persistence, keeping this module a pure "transcript in, structured
 *     analysis out" unit that's easy to unit-test without a live DB.
 */

const OPENROUTER_MODEL = 'anthropic/claude-haiku-4-5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HEADERS_EXTRA = {
  'HTTP-Referer': 'https://aria.certaprograndhaven.com',
  'X-Title': 'ARIA Sales Helper',
};

// Shared JSON-repair logic — lifted from server.js's runCoachingAnalysis()
// so all analysis functions tolerate the same Claude response quirks
// (markdown code fences, trailing commas, unquoted keys).
function parseJsonLoose(rawContent) {
  if (!rawContent) return null;
  try {
    return JSON.parse(rawContent);
  } catch {
    const stripped = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(stripped);
    } catch {
      const jsonMatch = stripped.match(/\{[\s\S]*\}/) || stripped.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return null;
      try {
        const repaired = jsonMatch[0]
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/([{,]\s*)(\w+):/g, '$1"$2":');
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
  }
}

async function callClaude(apiKey, systemPrompt, userPrompt, maxTokens = 1024) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...HEADERS_EXTRA,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    console.error('coachingAnalysis: empty response from Claude', JSON.stringify(data).slice(0, 300));
    return null;
  }
  return parseJsonLoose(rawContent);
}

// Build a numbered transcript block so the LLM can cite segment indices for
// timestamp lookups (segment index N -> real ts/speaker/text is resolved by
// the caller, not invented by the model).
function buildIndexedTranscript(segments) {
  return segments.map((s, i) => `[${i}] ${s.speaker}: ${s.text}`).join('\n');
}

// ─── Item 1: BANT + closing certainty ───────────────────────────────────────

const BANT_SYSTEM_PROMPT = `You are ARIA, a sales coaching analyst reviewing a completed sales meeting transcript for a CertaPro Painters field rep.

Score the meeting against the BANT framework:
- Budget: Has a price range, budget, or spending capacity been discussed or confirmed?
- Authority: Is the person(s) in the conversation the actual decision-maker, or do they need to check with someone else?
- Need: How clear and urgent is the prospect's underlying need/pain point?
- Timeline: Is there a concrete timeframe for when the work would happen / decision would be made?

For EACH factor, return a 0-100 score (0 = no evidence/strongly negative, 100 = fully confirmed/strongly positive) and a short one-sentence rationale citing what was (or wasn't) said.

Then compute an overall "closing certainty" 0-100 percentage representing how likely this deal is to close, informed by all four factors together (not simply the average — weigh Need and Authority most heavily, since a real need with real decision-making power matters more than a vague budget/timeline mention).

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{
  "budget": { "score": 0, "rationale": "..." },
  "authority": { "score": 0, "rationale": "..." },
  "need": { "score": 0, "rationale": "..." },
  "timeline": { "score": 0, "rationale": "..." },
  "closing_certainty_pct": 0,
  "overall_rationale": "One to two sentence summary of the certainty call."
}`;

/**
 * Returns { budget, authority, need, timeline, closing_certainty_pct, overall_rationale }
 * or null on failure / insufficient transcript / missing key.
 */
async function analyzeBant(apiKey, meetingId, segments) {
  if (!apiKey) return null;
  if (!segments || segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const userPrompt = `Meeting transcript:\n\n${transcriptText}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, BANT_SYSTEM_PROMPT, userPrompt, 700);
    if (!parsed) return null;

    const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    const factor = (f) => ({
      score: clamp(f?.score),
      rationale: typeof f?.rationale === 'string' ? f.rationale : '',
    });

    return {
      budget: factor(parsed.budget),
      authority: factor(parsed.authority),
      need: factor(parsed.need),
      timeline: factor(parsed.timeline),
      closing_certainty_pct: clamp(parsed.closing_certainty_pct),
      overall_rationale: typeof parsed.overall_rationale === 'string' ? parsed.overall_rationale : '',
    };
  } catch (err) {
    console.error(`coachingAnalysis.analyzeBant error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

// ─── Item 3: Insider-language flagger ───────────────────────────────────────

const INSIDER_LANGUAGE_SYSTEM_PROMPT = `You are ARIA, reviewing a sales meeting transcript between a CertaPro Painters field rep and a homeowner prospect.

Find every instance where the REP (not the prospect) uses industry jargon, internal company terminology, or an "insider" phrase that an average homeowner likely would NOT understand without explanation — e.g. painting-trade terms (e.g. "kickback", "cut-in", "back-rolling", "mil thickness"), CertaPro-internal process names used without explanation (e.g. "1st Go Around", "Certainty Pledge" used as a bare label with zero context), or vague internal shorthand.

Do NOT flag: normal conversational language, terms the rep clearly explained in the same breath, or common terms most homeowners would already know (e.g. "primer", "two coats", "estimate").

For each flagged instance, return the transcript segment index (the number in brackets, e.g. "[12]") where it occurred, the exact phrase, and a short explanation of why a prospect likely wouldn't understand it.

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{
  "flags": [
    { "segment_index": 12, "phrase": "back-rolling", "explanation": "Trade term for a roller technique after spraying — prospect has no context for this." }
  ]
}
If there are no flags, return { "flags": [] }.`;

/**
 * Returns an array of { segment_index, phrase, explanation } (index refers
 * to position in the `segments` array passed in), or null on failure.
 */
async function analyzeInsiderLanguage(apiKey, meetingId, segments) {
  if (!apiKey) return null;
  if (!segments || segments.length < 1) return [];

  const repSegmentCount = segments.length;
  if (repSegmentCount === 0) return [];

  const indexedTranscript = buildIndexedTranscript(segments);
  const userPrompt = `Meeting transcript (each line prefixed with its segment index in brackets):\n\n${indexedTranscript}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, INSIDER_LANGUAGE_SYSTEM_PROMPT, userPrompt, 1024);
    if (!parsed || !Array.isArray(parsed.flags)) return [];

    return parsed.flags
      .filter(f => f && typeof f.phrase === 'string' && f.phrase.trim())
      .map(f => ({
        segment_index: Number.isInteger(f.segment_index) ? f.segment_index : null,
        phrase: f.phrase.trim(),
        explanation: typeof f.explanation === 'string' ? f.explanation.trim() : '',
      }))
      .filter(f => f.segment_index !== null && f.segment_index >= 0 && f.segment_index < segments.length);
  } catch (err) {
    console.error(`coachingAnalysis.analyzeInsiderLanguage error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

// ─── Item 4: Question-listening gaps ────────────────────────────────────────

const QUESTION_GAPS_SYSTEM_PROMPT = `You are ARIA, reviewing a sales meeting transcript between a CertaPro Painters field rep and a homeowner prospect.

Find every instance where the PROSPECT (not the rep) asks a genuine question, AND the rep's next response(s) do not actually address that question — the rep talks past it, changes the subject, gives a non-answer, or answers a different question than what was asked.

Do NOT flag: rhetorical questions, questions the rep DID answer (even if briefly or imperfectly), or filler phrases that aren't really questions ("right?", "you know?").

For each real gap, return the transcript segment index of the PROSPECT's question, the exact question text, and a short excerpt of what the rep said instead (from the following segment(s)) plus a brief explanation of why it doesn't address the question.

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{
  "gaps": [
    { "question_segment_index": 8, "question_text": "How long will the whole job actually take?", "rep_response_excerpt": "So the primer we use is really high quality...", "explanation": "Rep pivoted to primer quality instead of answering the timeline question." }
  ]
}
If there are no gaps, return { "gaps": [] }.`;

/**
 * Returns an array of { question_segment_index, question_text,
 * rep_response_excerpt, explanation }, or null on failure.
 */
async function analyzeQuestionGaps(apiKey, meetingId, segments) {
  if (!apiKey) return null;
  if (!segments || segments.length < 2) return [];

  const indexedTranscript = buildIndexedTranscript(segments);
  const userPrompt = `Meeting transcript (each line prefixed with its segment index in brackets):\n\n${indexedTranscript}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, QUESTION_GAPS_SYSTEM_PROMPT, userPrompt, 1200);
    if (!parsed || !Array.isArray(parsed.gaps)) return [];

    return parsed.gaps
      .filter(g => g && typeof g.question_text === 'string' && g.question_text.trim())
      .map(g => ({
        question_segment_index: Number.isInteger(g.question_segment_index) ? g.question_segment_index : null,
        question_text: g.question_text.trim(),
        rep_response_excerpt: typeof g.rep_response_excerpt === 'string' ? g.rep_response_excerpt.trim() : '',
        explanation: typeof g.explanation === 'string' ? g.explanation.trim() : '',
      }))
      .filter(g => g.question_segment_index !== null && g.question_segment_index >= 0 && g.question_segment_index < segments.length);
  } catch (err) {
    console.error(`coachingAnalysis.analyzeQuestionGaps error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

// ─── Item 5: Live rebuttal teleprompter (rebuttal-generation half) ──────────
// This is the REAL part of item 5 — an actual Claude-via-OpenRouter call
// that generates a genuine suggested rebuttal for a detected objection. The
// STUB part (keyword-based objection detection, no ML) lives in
// objectionDetection.js and is what decides WHEN to call this function. See
// server.js's "suggested_rebuttal" WS scaffolding block for the full
// real-vs-stubbed breakdown and latency notes.
//
// Kept deliberately terse (low max_tokens, short prompt, small transcript
// context window of just the last few segments rather than the full
// transcript) since this runs mid-call and every added second of LLM
// latency directly delays what the rep sees on their live teleprompter.
const REBUTTAL_SYSTEM_PROMPT = `You are ARIA, giving a CertaPro Painters field rep a real-time rebuttal suggestion during a live sales conversation.

The prospect just raised an objection. Given the objection and a little recent context, write ONE short, natural-sounding rebuttal the rep could say next — conversational, not scripted-sounding, under 30 words, no bullet points.

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{ "rebuttal": "..." }`;

/**
 * generateRebuttal(apiKey, meetingId, objectionCategory, objectionText, recentSegments)
 * recentSegments: last few { speaker, text } entries for context (keep this
 * SHORT — a handful of segments, not the full transcript — to minimize
 * latency).
 * Returns a string rebuttal, or null on failure/missing key.
 */
async function generateRebuttal(apiKey, meetingId, objectionCategory, objectionText, recentSegments) {
  if (!apiKey) return null;
  if (!objectionText) return null;

  const contextText = (recentSegments || [])
    .slice(-4)
    .map(s => `${s.speaker}: ${s.text}`)
    .join('\n');

  const userPrompt = `Objection category (heuristic guess, may be imprecise): ${objectionCategory}
Prospect just said: "${objectionText}"

Recent context:
${contextText}

Return ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, REBUTTAL_SYSTEM_PROMPT, userPrompt, 150);
    if (!parsed || typeof parsed.rebuttal !== 'string' || !parsed.rebuttal.trim()) return null;
    return parsed.rebuttal.trim();
  } catch (err) {
    console.error(`coachingAnalysis.generateRebuttal error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

export { analyzeBant, analyzeInsiderLanguage, analyzeQuestionGaps, generateRebuttal, parseJsonLoose };
