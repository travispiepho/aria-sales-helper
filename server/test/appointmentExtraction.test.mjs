/**
 * appointmentExtraction.test.mjs — aria_setup_call_extract_appointment_button
 *
 * Unit coverage for coachingAnalysis.js's extractAppointmentDetails(), the
 * post-meeting, full-transcript counterpart to analyzeSetupCallCoaching()
 * (see that function's own header comment for the full "why a distinct
 * function" rationale). Same mocking pattern as setupCallCoaching.test.mjs's
 * analyzeSetupCallCoaching() tests: a fake global.fetch standing in for the
 * OpenRouter/Claude call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAppointmentDetails, mergeProjectInfo } from '../coachingAnalysis.js';

function mockFetchOnce(responseObj) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(responseObj) } }] }),
    };
  };
  return { fetchImpl, calls };
}

test('extractAppointmentDetails: returns null with no api key, or with an empty transcript', async () => {
  assert.equal(await extractAppointmentDetails(null, 'm1', [{ speaker: 'Rep', text: 'hi' }]), null);
  assert.equal(await extractAppointmentDetails('key', 'm1', []), null);
  assert.equal(await extractAppointmentDetails('key', 'm1', null), null);
});

test('extractAppointmentDetails: processes a short (even <3 segment) transcript, unlike the live >=3 minimum', async (t) => {
  const llmResponse = {
    project_info: {
      customer_name: 'Jane Doe',
      customer_address: '123 Main St',
      project_type: 'exterior repaint',
      scope_notes: null,
      approx_size_sqft: null,
      timeline_urgency: null,
      budget_signal: null,
      appointment_set: true,
      appointment_date_time: 'Thursday at 2pm',
      notes: null,
    },
  };
  const originalFetch = global.fetch;
  const { fetchImpl, calls } = mockFetchOnce(llmResponse);
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  // Only 2 segments — below analyzeSetupCallCoaching()'s >=3 live-call
  // minimum, but this is a completed call, so even a very short finished
  // transcript should still be extractable.
  const segments = [
    { speaker: 'Rep', text: 'Hi Jane, does Thursday at 2pm work for the in-person visit at 123 Main St?' },
    { speaker: 'Customer', text: 'Yes, Thursday at 2pm works great.' },
  ];

  const result = await extractAppointmentDetails('fake-key', 'meeting-1', segments, {});

  assert.equal(calls.length, 1);
  assert.equal(result.mode, 'appointment_extraction');
  assert.equal('disc' in result, false, 'post-call extraction must not include live DISC coaching');
  assert.equal('nudges' in result, false, 'post-call extraction must not include live nudges');
  assert.equal('urgent' in result, false, 'post-call extraction must not include live urgent coaching');
  assert.equal(result.project_info.customer_name, 'Jane Doe');
  assert.equal(result.project_info.customer_address, '123 Main St');
  assert.equal(result.project_info.appointment_set, true);
  assert.equal(result.project_info.appointment_date_time, 'Thursday at 2pm');
});

test('extractAppointmentDetails: merges onto existingProjectInfo (sticky, non-destructive) via the shared mergeProjectInfo()', async (t) => {
  const llmResponse = {
    project_info: {
      customer_name: null, // not re-mentioned in this pass's transcript excerpt
      customer_address: null,
      project_type: null,
      scope_notes: null,
      approx_size_sqft: null,
      timeline_urgency: null,
      budget_signal: null,
      appointment_set: true,
      appointment_date_time: 'Friday at 10am — confirmed at the very end of the call',
      notes: null,
    },
  };
  const originalFetch = global.fetch;
  const { fetchImpl } = mockFetchOnce(llmResponse);
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  const existing = {
    customer_name: 'Jane Doe', customer_address: null, project_type: 'exterior repaint',
    scope_notes: null, approx_size_sqft: null, timeline_urgency: null, budget_signal: null,
    appointment_set: false, appointment_date_time: null, notes: null,
  };

  const segments = [
    { speaker: 'Rep', text: 'Actually, before we hang up — does Friday at 10am work instead?' },
    { speaker: 'Customer', text: 'Sure, Friday at 10am is fine.' },
  ];

  const result = await extractAppointmentDetails('fake-key', 'meeting-1', segments, existing);

  // Previously-known facts survive (sticky merge).
  assert.equal(result.project_info.customer_name, 'Jane Doe');
  assert.equal(result.project_info.project_type, 'exterior repaint');
  // The late-confirmed appointment is now captured.
  assert.equal(result.project_info.appointment_set, true);
  assert.equal(result.project_info.appointment_date_time, 'Friday at 10am — confirmed at the very end of the call');

  // Sanity-check this really is the same merge function the live path uses.
  const manualMerge = mergeProjectInfo(existing, llmResponse.project_info);
  assert.deepEqual(result.project_info, manualMerge);
});

test('extractAppointmentDetails: returns null on LLM/network failure', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  t.after(() => { global.fetch = originalFetch; });

  const segments = [{ speaker: 'Rep', text: 'Hi there' }, { speaker: 'Customer', text: 'Hello' }];
  const result = await extractAppointmentDetails('fake-key', 'meeting-1', segments, {});
  assert.equal(result, null);
});

test('extractAppointmentDetails: returns null when the LLM response is missing project_info', async (t) => {
  const originalFetch = global.fetch;
  const { fetchImpl } = mockFetchOnce({ unrelated: 'shape' });
  global.fetch = fetchImpl;
  t.after(() => { global.fetch = originalFetch; });

  const segments = [{ speaker: 'Rep', text: 'Hi there' }, { speaker: 'Customer', text: 'Hello' }];
  const result = await extractAppointmentDetails('fake-key', 'meeting-1', segments, {});
  assert.equal(result, null);
});
