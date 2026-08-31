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
 *
 * `systemPrompt` (added 2026-08-30, aria_coaching_settings_prompt_editor_backend):
 * optional override, defaulting to the hardcoded BANT_SYSTEM_PROMPT above.
 * server.js's route handler fetches the current admin-editable prompt text
 * via coachingPrompts.js's getPromptText('bant', BANT_SYSTEM_PROMPT) and
 * passes it in here — BANT_SYSTEM_PROMPT itself remains as the documented
 * seed/fallback default (used by the migration's seed data and as the
 * safety-net value if the DB row is ever missing/unreachable), not deleted.
 */
async function analyzeBant(apiKey, meetingId, segments, systemPrompt = BANT_SYSTEM_PROMPT) {
  if (!apiKey) return null;
  if (!segments || segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const userPrompt = `Meeting transcript:\n\n${transcriptText}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 700);
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
 *
 * `systemPrompt`: optional override (see analyzeBant()'s comment above for
 * the full rationale), defaulting to the hardcoded
 * INSIDER_LANGUAGE_SYSTEM_PROMPT seed/fallback.
 */
async function analyzeInsiderLanguage(apiKey, meetingId, segments, systemPrompt = INSIDER_LANGUAGE_SYSTEM_PROMPT) {
  if (!apiKey) return null;
  if (!segments || segments.length < 1) return [];

  const repSegmentCount = segments.length;
  if (repSegmentCount === 0) return [];

  const indexedTranscript = buildIndexedTranscript(segments);
  const userPrompt = `Meeting transcript (each line prefixed with its segment index in brackets):\n\n${indexedTranscript}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 1024);
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
 *
 * `systemPrompt`: optional override (see analyzeBant()'s comment above for
 * the full rationale), defaulting to the hardcoded
 * QUESTION_GAPS_SYSTEM_PROMPT seed/fallback.
 */
async function analyzeQuestionGaps(apiKey, meetingId, segments, systemPrompt = QUESTION_GAPS_SYSTEM_PROMPT) {
  if (!apiKey) return null;
  if (!segments || segments.length < 2) return [];

  const indexedTranscript = buildIndexedTranscript(segments);
  const userPrompt = `Meeting transcript (each line prefixed with its segment index in brackets):\n\n${indexedTranscript}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 1200);
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
 * generateRebuttal(apiKey, meetingId, objectionCategory, objectionText, recentSegments, systemPrompt)
 * recentSegments: last few { speaker, text } entries for context (keep this
 * SHORT — a handful of segments, not the full transcript — to minimize
 * latency).
 * `systemPrompt`: optional override (see analyzeBant()'s comment above for
 * the full rationale), defaulting to the hardcoded REBUTTAL_SYSTEM_PROMPT
 * seed/fallback.
 * Returns a string rebuttal, or null on failure/missing key.
 */
async function generateRebuttal(apiKey, meetingId, objectionCategory, objectionText, recentSegments, systemPrompt = REBUTTAL_SYSTEM_PROMPT) {
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
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 150);
    if (!parsed || typeof parsed.rebuttal !== 'string' || !parsed.rebuttal.trim()) return null;
    return parsed.rebuttal.trim();
  } catch (err) {
    console.error(`coachingAnalysis.generateRebuttal error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

// ─── aria_setup_call_coaching_differentiation (2026-08-30) ─────────────────
//
// Background: every over-the-phone call on ARIA is functionally just
// STAGE 1 of the CertaPro 10+1 sales process — a short "Setup Call" where
// the rep collects basic project info and books the in-person walkthrough
// (see server.js's COACHING_SYSTEM_PROMPT / knowledge/certapro-10plus1-
// sales-process.md STAGE 1 for the in-person-framework's own definition of
// this same stage). The 11-stage stage/checklist/progress-bar coaching
// machinery (coaching_stages table, see migrations/2026-08-30-coaching-
// stages.sql) describes an IN-PERSON WALKTHROUGH's flow end-to-end and
// does not make sense to run against a 5-minute phone scheduling call.
//
// isSetupCallPhoneMeeting() is the meeting-type discriminator, deliberately
// mirroring the EXACT compound check the web frontend already uses for the
// identical purpose (web/src/pages/MeetingPage.tsx's `isTwilioPhoneCall` /
// `isTwilioPhoneMeeting`, both `meeting.channel === 'phone' && !!meeting.
// call_sid`) so backend and frontend agree on what counts as a real
// Twilio-bridged phone call. See that file's own extensive comment for WHY
// `channel === 'phone'` alone is insufficient (mobile's local-mic phone-
// channel meetings have no call_sid and must NOT be treated as setup-call
// mode — they still get full in-person-shaped coaching).
//
// BROWSER CALLS: a browser-originated call (telephony.js's
// /telephony/browser-outgoing route) also goes through the SAME
// findOrCreatePhoneMeeting() helper as an inbound/outbound plain phone
// call, writing the identical channel='phone' + call_sid columns onto the
// same `meetings` row shape — there is no separate schema/column for
// "browser call" vs "phone call" anywhere in this codebase. This compound
// check therefore ALSO matches browser calls, by construction, with zero
// extra branching needed — which is the correct behavior here: a browser
// call is still just a setup call, and Gabe's framing ("every over-the-
// phone call... is just a Setup_call") applies to it exactly the same way
// it applies to a landline-bridged Twilio call. This is a SEPARATE concern
// from the queued `aria_browser_call_coaching_not_active_fix` task, which
// (per investigation during this task) appears to be about
// runCoachingAnalysis() never being INVOKED at all on the Twilio Media
// Stream path (telephony.js's per-track onTranscript handler inserts
// transcript_segments and broadcasts `final`, but — unlike the in-person
// audio WS handler and uploadedRecording.js's WS handler — never calls
// runCoachingAnalysis() itself). That auto-trigger gap is out of scope for
// THIS task (write-scope explicitly excludes telephony.js) and is left for
// that queued task to fix; this module's job is only to make sure
// runCoachingAnalysis() does the RIGHT THING once/whenever it IS invoked
// for a phone-channel meeting (manual POST /api/meetings/:id/coaching
// today, and automatically once that separate bug is fixed).
function isSetupCallPhoneMeeting(meeting) {
  return !!meeting && meeting.channel === 'phone' && !!meeting.call_sid;
}

const SETUP_CALL_SYSTEM_PROMPT = `You are ARIA, a real-time sales coaching assistant for CertaPro Painters field reps.

This transcript is from an OVER-THE-PHONE "Setup Call" — a short call (often just a few minutes) where the rep's job is to:
1. Build quick rapport and confirm how the prospect heard about CertaPro
2. Collect basic information about the painting project (what it is, rough scope/size, timeline, any budget signals)
3. Book a specific date/time for an in-person walkthrough visit

This is NOT a full in-person walkthrough — do NOT try to walk the rep through color selection, the Certainty Pledge, a detailed carpentry/repairs review, or any other stage of the full sales process. Those all happen later, in person. Your ONLY jobs here are: (a) read the prospect's DISC style from how they talk, (b) nudge the rep toward finishing the two things this call exists for (get the project basics, lock the in-person appointment), and (c) extract the concrete project facts mentioned so far so they can be handed to the rep before the in-person visit.

Detect:
- The prospect's DISC style from their speech patterns, pace, word choices, and intonation descriptions
- Concrete facts about the project mentioned in the call
- Whether a specific in-person appointment date/time has been agreed to

FIELD GUIDANCE:
- disc.tip: Static one-liner on how to sell to this style (under 15 words). Example: "Lead with ROI, skip the story."
- nudges: 1-4 short action items for what the rep should do next ON THIS CALL (under 10 words each) — e.g. confirming the visit time, asking about timeline, or getting a rough project scope. Never suggest an in-person-only action (colors, Certainty Pledge, carpentry review, etc.).
- urgent: DISC-based situational coaching for THIS call — if the rep made a misstep, missed a read on the prospect's style, or is drifting toward in-person-only territory that doesn't belong on a setup call, write a brief recovery tip here. The rep reads this mid-call while actively talking to the customer, so it must be glanceable in under two seconds: ONE short sentence, 12 words or fewer, imperative and actionable. Set to null if the call is on track.
- project_info: extract ONLY facts explicitly stated in the transcript (do not guess or infer beyond what was said). Use null for anything not mentioned. Fields:
  - customer_name: prospect's name if given and not already on file
  - customer_address: the project address if given
  - project_type: e.g. "exterior repaint", "interior painting", "deck staining", "cabinet refinish"
  - scope_notes: free-text notes on rooms/areas/surfaces mentioned
  - approx_size_sqft: a number if a rough size was mentioned (square footage, number of rooms translated to a rough estimate, etc.), else null
  - timeline_urgency: e.g. "ASAP", "before winter", "no rush", "within 2 weeks"
  - budget_signal: any budget/price-range language the prospect volunteered
  - appointment_set: true ONLY if a specific in-person visit date/time was explicitly agreed to in this transcript, else false
  - appointment_date_time: the agreed date/time as stated (natural language is fine, e.g. "Thursday at 2pm"), else null
  - notes: anything else worth a rep knowing before the in-person visit

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{
  "disc": { "detected": "D", "confidence": "medium", "emoji": "🦅", "label": "Dominant (Eagle)", "tip": "Be direct, lead with outcomes" },
  "nudges": ["Confirm the visit day/time"],
  "urgent": null,
  "project_info": {
    "customer_name": null,
    "customer_address": null,
    "project_type": null,
    "scope_notes": null,
    "approx_size_sqft": null,
    "timeline_urgency": null,
    "budget_signal": null,
    "appointment_set": false,
    "appointment_date_time": null,
    "notes": null
  }
}`;

function normalizeSetupCallDisc(disc) {
  return {
    detected: typeof disc?.detected === 'string' ? disc.detected : null,
    confidence: typeof disc?.confidence === 'string' ? disc.confidence : null,
    emoji: typeof disc?.emoji === 'string' ? disc.emoji : '',
    label: typeof disc?.label === 'string' ? disc.label : '',
    tip: typeof disc?.tip === 'string' ? disc.tip : '',
  };
}

// Merge a freshly-extracted project_info reading on top of what was already
// persisted for this meeting (from earlier in the same call). Later reads
// only ever ADD/REFINE information, never silently erase an earlier fact
// the model happened not to re-mention this pass — same "once observed,
// stays observed" convention this repo already uses for checklist items
// (see server.js's GET /api/meetings/:id/coaching/latest merge logic).
// `appointment_set` is explicitly sticky-true for the same reason: once an
// in-person visit has been booked earlier in the call, a later transcript
// window that doesn't happen to re-mention it must not flip this back to
// false and hide the fact a visit was already scheduled.
function mergeProjectInfo(existing, extracted) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const next = extracted && typeof extracted === 'object' ? extracted : {};
  const pick = (key) => {
    const v = next[key];
    if (v === null || v === undefined) return prev[key] ?? null;
    if (typeof v === 'string' && v.trim() === '') return prev[key] ?? null;
    return v;
  };
  return {
    customer_name: pick('customer_name'),
    customer_address: pick('customer_address'),
    project_type: pick('project_type'),
    scope_notes: pick('scope_notes'),
    approx_size_sqft: typeof next.approx_size_sqft === 'number' && Number.isFinite(next.approx_size_sqft)
      ? next.approx_size_sqft
      : (prev.approx_size_sqft ?? null),
    timeline_urgency: pick('timeline_urgency'),
    budget_signal: pick('budget_signal'),
    appointment_set: next.appointment_set === true ? true : (prev.appointment_set === true),
    appointment_date_time: pick('appointment_date_time'),
    notes: pick('notes'),
  };
}

/**
 * analyzeSetupCallCoaching(apiKey, meetingId, segments, existingProjectInfo)
 *
 * Setup-call coaching mode: ONE combined LLM call (same design as
 * server.js's runCoachingAnalysis() in-person prompt — a single round trip
 * producing everything the live UI needs) that returns DISC + nudges +
 * urgent (kept alive for phone calls, per this task's brief — "a rep can
 * still get DISC-style read and urgent nudges on a phone call") PLUS the
 * new `project_info` extraction, and explicitly OMITS stage/checklist
 * (the 11-step walkthrough machinery that does not apply to this meeting
 * type).
 *
 * `existingProjectInfo` is whatever is already persisted in
 * setup_call_project_info for this meeting (or {} if none yet) — passed
 * back to the model as known-context so it doesn't need to re-derive
 * already-confirmed facts, and so the merge in mergeProjectInfo() has
 * something to merge on top of.
 *
 * Returns { mode: 'setup_call', disc, nudges, urgent, project_info } or
 * null on failure/missing key/insufficient transcript, matching every
 * other function in this module's null-on-failure convention.
 *
 * `systemPrompt` (added 2026-08-30, aria_coaching_settings_prompt_editor_backend):
 * optional override, defaulting to the hardcoded SETUP_CALL_SYSTEM_PROMPT
 * seed/fallback (see analyzeBant()'s comment above for the full
 * rationale).
 */
async function analyzeSetupCallCoaching(apiKey, meetingId, segments, existingProjectInfo = {}, systemPrompt = SETUP_CALL_SYSTEM_PROMPT) {
  if (!apiKey) return null;
  if (!segments || segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const knownContext = JSON.stringify(existingProjectInfo && typeof existingProjectInfo === 'object' ? existingProjectInfo : {});
  const userPrompt = `Already known about this project from earlier in the call (JSON, may be all-null if nothing confirmed yet):\n${knownContext}\n\nMeeting transcript so far:\n\n${transcriptText}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 700);
    if (!parsed) return null;

    let urgent = parsed.urgent ?? null;
    if (urgent && typeof urgent === 'object') {
      urgent = urgent.message || urgent.flag || JSON.stringify(urgent);
    }
    if (typeof urgent !== 'string') urgent = null;

    const nudges = Array.isArray(parsed.nudges)
      ? parsed.nudges.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
      : [];

    return {
      mode: 'setup_call',
      disc: normalizeSetupCallDisc(parsed.disc),
      nudges,
      urgent,
      project_info: mergeProjectInfo(existingProjectInfo, parsed.project_info),
    };
  } catch (err) {
    console.error(`coachingAnalysis.analyzeSetupCallCoaching error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

// ─── aria_setup_call_extract_appointment_button (2026-08-30) ───────────────
//
// Background: analyzeSetupCallCoaching() above already runs DURING a setup
// call, on the full transcript captured so far, and already extracts
// project_info (including appointment_set/appointment_date_time) — see
// runCoachingAnalysis()'s setup-call branch in server.js, which fetches
// ALL transcript_segments for the meeting (not a windowed subset) on every
// tick. So the live pipeline is not blind to the whole conversation.
//
// The real gap this task closes: the live pass only runs when something
// (a periodic tick, a manual "Refresh Coaching") actually INVOKES it while
// the call is still active. If the appointment gets confirmed in the
// closing seconds of the call — right before the rep hangs up — there may
// never be another live coaching tick after that moment to pick it up.
// This function is the POST-MEETING, rep-triggered re-analysis pass: it
// runs once, after the call has fully ended, against the definitively
// COMPLETE transcript, specifically to catch anything only said at the
// very end.
//
// Deliberately NOT a parallel extraction pipeline: this reuses the exact
// same `project_info` field contract and the exact same mergeProjectInfo()
// sticky-merge semantics as the live setup-call coaching mode (see that
// function's own header for the full stickiness rationale), so its output
// slots directly into the same setup_call_project_info row/UI with zero
// new shape to teach the frontend. The prompt itself is a natural,
// narrower variant of SETUP_CALL_SYSTEM_PROMPT above: same project_info
// field list and field guidance verbatim, minus the live-call-only
// DISC/nudges/urgent coaching fields (those are meaningless once the call
// has already ended — nothing left to coach in real time), plus an
// explicit "this is the whole finished call, look everywhere" framing
// instead of "so far".
const APPOINTMENT_EXTRACTION_SYSTEM_PROMPT = `You are ARIA, doing a POST-CALL extraction pass over the COMPLETE, FINISHED transcript of an over-the-phone CertaPro Painters "Setup Call" (a short call where a rep collects basic project info and books an in-person walkthrough).

The call is over — you have the entire conversation below, not a partial window. Read all of it carefully for any project fact or in-person appointment detail mentioned ANYWHERE, including things confirmed only near the very end of the call (e.g. a date/time agreed to right before hanging up). Extract ONLY facts explicitly stated in the transcript — do not guess or infer beyond what was said. Use null for anything not mentioned.

Fields:
  - customer_name: prospect's name if given
  - customer_address: the project address if given
  - project_type: e.g. "exterior repaint", "interior painting", "deck staining", "cabinet refinish"
  - scope_notes: free-text notes on rooms/areas/surfaces mentioned
  - approx_size_sqft: a number if a rough size was mentioned (square footage, number of rooms translated to a rough estimate, etc.), else null
  - timeline_urgency: e.g. "ASAP", "before winter", "no rush", "within 2 weeks"
  - budget_signal: any budget/price-range language the prospect volunteered
  - appointment_set: true ONLY if a specific in-person visit date/time was explicitly agreed to anywhere in this transcript, else false
  - appointment_date_time: the agreed date/time as stated (natural language is fine, e.g. "Thursday at 2pm"), else null
  - notes: anything else worth a rep knowing before the in-person visit

Return ONLY raw JSON, no prose, no markdown, in this exact shape:
{
  "project_info": {
    "customer_name": null,
    "customer_address": null,
    "project_type": null,
    "scope_notes": null,
    "approx_size_sqft": null,
    "timeline_urgency": null,
    "budget_signal": null,
    "appointment_set": false,
    "appointment_date_time": null,
    "notes": null
  }
}`;

/**
 * extractAppointmentDetails(apiKey, meetingId, segments, existingProjectInfo, systemPrompt)
 *
 * The post-meeting, full-transcript counterpart to analyzeSetupCallCoaching()
 * — see the comment block above for why this exists as a distinct function
 * rather than just re-calling analyzeSetupCallCoaching() (that function
 * also generates DISC/nudges/urgent, which have no meaning post-call, and
 * its >=3-segment minimum is a live-call safety net that doesn't apply
 * here — a short-but-complete call with even 1-2 segments should still be
 * extractable post-hoc).
 *
 * `segments` is expected to be the FULL, final transcript_segments for the
 * meeting (server.js's route handler is responsible for fetching all of
 * them, unfiltered/unwindowed).
 *
 * `existingProjectInfo` is merged the same way analyzeSetupCallCoaching()
 * merges it (mergeProjectInfo(), sticky/non-destructive) so a rep who runs
 * this after live coaching already captured some facts never loses them —
 * this pass can only add to or corroborate what's already there.
 *
 * Returns { mode: 'appointment_extraction', project_info } or null on
 * failure/missing key/empty transcript, matching this module's existing
 * null-on-failure convention.
 */
async function extractAppointmentDetails(apiKey, meetingId, segments, existingProjectInfo = {}, systemPrompt = APPOINTMENT_EXTRACTION_SYSTEM_PROMPT) {
  if (!apiKey) return null;
  if (!segments || segments.length === 0) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
  const knownContext = JSON.stringify(existingProjectInfo && typeof existingProjectInfo === 'object' ? existingProjectInfo : {});
  const userPrompt = `Already known about this project from live coaching during the call (JSON, may be all-null if nothing was captured live):\n${knownContext}\n\nFull, complete transcript of the finished call:\n\n${transcriptText}\n\nReturn ONLY the JSON object described in the system prompt.`;

  try {
    const parsed = await callClaude(apiKey, systemPrompt, userPrompt, 500);
    if (!parsed || !parsed.project_info) return null;

    return {
      mode: 'appointment_extraction',
      project_info: mergeProjectInfo(existingProjectInfo, parsed.project_info),
    };
  } catch (err) {
    console.error(`coachingAnalysis.extractAppointmentDetails error (meeting ${meetingId}):`, err.message);
    return null;
  }
}

export {
  analyzeBant,
  analyzeInsiderLanguage,
  analyzeQuestionGaps,
  generateRebuttal,
  parseJsonLoose,
  isSetupCallPhoneMeeting,
  analyzeSetupCallCoaching,
  extractAppointmentDetails,
  mergeProjectInfo,
  // Hardcoded prompt constants, exported (2026-08-30,
  // aria_coaching_settings_prompt_editor_backend) as documented SEED/
  // fallback defaults for coachingPrompts.js's getPromptText() — used to
  // seed the coaching_prompts migration and as the safety-net value if a
  // DB row is ever missing/unreachable. NOT the source of truth anymore;
  // see coachingPrompts.js's header comment.
  BANT_SYSTEM_PROMPT,
  INSIDER_LANGUAGE_SYSTEM_PROMPT,
  QUESTION_GAPS_SYSTEM_PROMPT,
  REBUTTAL_SYSTEM_PROMPT,
  SETUP_CALL_SYSTEM_PROMPT,
  APPOINTMENT_EXTRACTION_SYSTEM_PROMPT,
};
