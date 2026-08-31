// coachingAnalysisPromptOverride.test.mjs
//
// Regression + contract tests for aria_coaching_settings_prompt_editor_backend:
// every coachingAnalysis.js function that calls the LLM must (a) still work
// exactly as before when called WITHOUT an explicit systemPrompt argument
// (regression — the hardcoded constant remains the default), and (b) send
// whatever systemPrompt IS passed in as the actual 'system' message content
// sent to the LLM, so an admin's DB-stored edit really does change what the
// coaching engine asks for.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeBant,
  analyzeInsiderLanguage,
  analyzeQuestionGaps,
  generateRebuttal,
  analyzeSetupCallCoaching,
  BANT_SYSTEM_PROMPT,
  INSIDER_LANGUAGE_SYSTEM_PROMPT,
  QUESTION_GAPS_SYSTEM_PROMPT,
  REBUTTAL_SYSTEM_PROMPT,
  SETUP_CALL_SYSTEM_PROMPT,
} from '../coachingAnalysis.js';

function mockFetchCapturingSystemPrompt(responseObj) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    const systemMessage = body.messages.find((m) => m.role === 'system');
    calls.push({ systemPrompt: systemMessage?.content });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(responseObj) } }] }),
    };
  };
  return { fetchImpl, calls };
}

const segments = [
  { speaker: 'Rep', text: 'Thanks for having me out today.' },
  { speaker: 'Customer', text: 'Sure, happy to talk about the project.' },
  { speaker: 'Rep', text: 'Let\'s start with what you have in mind.' },
];

test('analyzeBant: without an override, sends the hardcoded BANT_SYSTEM_PROMPT (regression)', async (t) => {
  const bantResponse = {
    budget: { score: 50, rationale: 'r' }, authority: { score: 50, rationale: 'r' },
    need: { score: 50, rationale: 'r' }, timeline: { score: 50, rationale: 'r' },
    closing_certainty_pct: 50, overall_rationale: 'r',
  };
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt(bantResponse);
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  const result = await analyzeBant('fake-key', 'm1', segments);
  assert.ok(result);
  assert.equal(calls[0].systemPrompt, BANT_SYSTEM_PROMPT);
});

test('analyzeBant: with an override, sends the OVERRIDE text as the system prompt (admin-edit contract)', async (t) => {
  const bantResponse = {
    budget: { score: 50, rationale: 'r' }, authority: { score: 50, rationale: 'r' },
    need: { score: 50, rationale: 'r' }, timeline: { score: 50, rationale: 'r' },
    closing_certainty_pct: 50, overall_rationale: 'r',
  };
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt(bantResponse);
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  const customPrompt = 'CUSTOM ADMIN-EDITED BANT PROMPT — completely different wording.';
  const result = await analyzeBant('fake-key', 'm1', segments, customPrompt);
  assert.ok(result);
  assert.equal(calls[0].systemPrompt, customPrompt);
  assert.notEqual(calls[0].systemPrompt, BANT_SYSTEM_PROMPT);
});

test('analyzeInsiderLanguage: defaults to hardcoded prompt, honors override', async (t) => {
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt({ flags: [] });
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  await analyzeInsiderLanguage('fake-key', 'm1', segments);
  assert.equal(calls[0].systemPrompt, INSIDER_LANGUAGE_SYSTEM_PROMPT);

  const customPrompt = 'CUSTOM insider-language prompt.';
  await analyzeInsiderLanguage('fake-key', 'm1', segments, customPrompt);
  assert.equal(calls[1].systemPrompt, customPrompt);
});

test('analyzeQuestionGaps: defaults to hardcoded prompt, honors override', async (t) => {
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt({ gaps: [] });
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  await analyzeQuestionGaps('fake-key', 'm1', segments);
  assert.equal(calls[0].systemPrompt, QUESTION_GAPS_SYSTEM_PROMPT);

  const customPrompt = 'CUSTOM question-gaps prompt.';
  await analyzeQuestionGaps('fake-key', 'm1', segments, customPrompt);
  assert.equal(calls[1].systemPrompt, customPrompt);
});

test('generateRebuttal: defaults to hardcoded prompt, honors override', async (t) => {
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt({ rebuttal: 'Sure, let me explain the value.' });
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  await generateRebuttal('fake-key', 'm1', 'price', 'That seems expensive.', segments);
  assert.equal(calls[0].systemPrompt, REBUTTAL_SYSTEM_PROMPT);

  const customPrompt = 'CUSTOM rebuttal prompt.';
  await generateRebuttal('fake-key', 'm1', 'price', 'That seems expensive.', segments, customPrompt);
  assert.equal(calls[1].systemPrompt, customPrompt);
});

test('analyzeSetupCallCoaching: defaults to hardcoded prompt, honors override', async (t) => {
  const setupResponse = {
    disc: { detected: 'I', confidence: 'medium', emoji: '🦜', label: 'Influential (Parrot)', tip: 'tip' },
    nudges: [], urgent: null,
    project_info: {
      customer_name: null, customer_address: null, project_type: null, scope_notes: null,
      approx_size_sqft: null, timeline_urgency: null, budget_signal: null,
      appointment_set: false, appointment_date_time: null, notes: null,
    },
  };
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchCapturingSystemPrompt(setupResponse);
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  await analyzeSetupCallCoaching('fake-key', 'm1', segments, {});
  assert.equal(calls[0].systemPrompt, SETUP_CALL_SYSTEM_PROMPT);

  const customPrompt = 'CUSTOM setup-call prompt.';
  await analyzeSetupCallCoaching('fake-key', 'm1', segments, {}, customPrompt);
  assert.equal(calls[1].systemPrompt, customPrompt);
});
