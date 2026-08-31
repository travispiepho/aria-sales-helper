import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSetupCallPhoneMeeting,
  isSetupCallMeeting,
  analyzeSetupCallCoaching,
  mergeProjectInfo,
} from '../coachingAnalysis.js';

// ─── isSetupCallPhoneMeeting: meeting-type detection ───────────────────────
// Mirrors web/src/pages/MeetingPage.tsx's isTwilioPhoneCall/isTwilioPhoneMeeting
// exactly: channel === 'phone' && !!call_sid.

test('isSetupCallPhoneMeeting: true only for channel=phone with a call_sid', () => {
  assert.equal(isSetupCallPhoneMeeting({ channel: 'phone', call_sid: 'CA123' }), true);
  assert.equal(isSetupCallPhoneMeeting({ channel: 'phone', call_sid: null }), false);
  assert.equal(isSetupCallPhoneMeeting({ channel: 'phone', call_sid: undefined }), false);
  assert.equal(isSetupCallPhoneMeeting({ channel: 'phone' }), false);
  assert.equal(isSetupCallPhoneMeeting({ channel: 'in_person', call_sid: 'CA123' }), false);
  assert.equal(isSetupCallPhoneMeeting({ channel: 'uploaded_recording', call_sid: 'CA123' }), false);
  assert.equal(isSetupCallPhoneMeeting(null), false);
  assert.equal(isSetupCallPhoneMeeting(undefined), false);
});

// ─── isSetupCallMeeting: unified discriminator (aria_recording_analysis_meeting_type_choice) ───
// Widened superset of isSetupCallPhoneMeeting(): live phone/browser calls
// are UNCHANGED (auto-detected via channel+call_sid); uploaded recordings
// use the EXPLICIT persisted rep choice (setup_call_choice) instead, since
// they have no channel/call_sid signal to auto-detect from.

test('isSetupCallMeeting: phone/browser calls are unaffected — identical to isSetupCallPhoneMeeting', () => {
  assert.equal(isSetupCallMeeting({ channel: 'phone', call_sid: 'CA123' }), true);
  assert.equal(isSetupCallMeeting({ channel: 'phone', call_sid: null }), false);
  assert.equal(isSetupCallMeeting({ channel: 'phone' }), false);
  assert.equal(isSetupCallMeeting({ channel: 'in_person', call_sid: 'CA123' }), false);
  assert.equal(isSetupCallMeeting(null), false);
  assert.equal(isSetupCallMeeting(undefined), false);
});

test('isSetupCallMeeting: uploaded recordings use the explicit setup_call_choice column, never channel/call_sid', () => {
  assert.equal(isSetupCallMeeting({ channel: 'uploaded_recording', setup_call_choice: true }), true);
  assert.equal(isSetupCallMeeting({ channel: 'uploaded_recording', setup_call_choice: false }), false);
  // NULL (not-yet-chosen / pre-migration row) must never be treated as true.
  assert.equal(isSetupCallMeeting({ channel: 'uploaded_recording', setup_call_choice: null }), false);
  assert.equal(isSetupCallMeeting({ channel: 'uploaded_recording' }), false);
  // An uploaded recording can never have a call_sid in practice, but even if
  // one were present it must NOT leak into a setup-call determination for
  // this channel — only setup_call_choice governs uploaded recordings.
  assert.equal(isSetupCallMeeting({ channel: 'uploaded_recording', call_sid: 'CA999', setup_call_choice: false }), false);
});

// ─── mergeProjectInfo: sticky-merge semantics ──────────────────────────────

test('mergeProjectInfo: fills in previously-null fields from a new extraction', () => {
  const prev = {
    customer_name: null, customer_address: null, project_type: null,
    scope_notes: null, approx_size_sqft: null, timeline_urgency: null,
    budget_signal: null, appointment_set: false, appointment_date_time: null,
    notes: null,
  };
  const extracted = {
    customer_name: 'Jane Doe', project_type: 'exterior repaint',
    appointment_set: false, appointment_date_time: null,
  };
  const merged = mergeProjectInfo(prev, extracted);
  assert.equal(merged.customer_name, 'Jane Doe');
  assert.equal(merged.project_type, 'exterior repaint');
  assert.equal(merged.customer_address, null);
  assert.equal(merged.appointment_set, false);
});

test('mergeProjectInfo: never un-sets a previously-confirmed fact when the new pass returns null', () => {
  const prev = { customer_name: 'Jane Doe', project_type: 'exterior repaint', appointment_set: true, appointment_date_time: 'Thursday at 2pm' };
  const extracted = { customer_name: null, project_type: null, appointment_set: false, appointment_date_time: null };
  const merged = mergeProjectInfo(prev, extracted);
  assert.equal(merged.customer_name, 'Jane Doe', 'customer_name must remain sticky');
  assert.equal(merged.project_type, 'exterior repaint', 'project_type must remain sticky');
  assert.equal(merged.appointment_set, true, 'appointment_set must be sticky-true once booked');
  assert.equal(merged.appointment_date_time, 'Thursday at 2pm', 'appointment_date_time must remain sticky');
});

test('mergeProjectInfo: appointment_set flips true once the model confirms it, and stays true after', () => {
  let info = mergeProjectInfo({}, { appointment_set: false });
  assert.equal(info.appointment_set, false);
  info = mergeProjectInfo(info, { appointment_set: true, appointment_date_time: 'Friday 10am' });
  assert.equal(info.appointment_set, true);
  assert.equal(info.appointment_date_time, 'Friday 10am');
  // A later pass that doesn't re-confirm must not un-set it.
  info = mergeProjectInfo(info, { appointment_set: false, appointment_date_time: null });
  assert.equal(info.appointment_set, true);
  assert.equal(info.appointment_date_time, 'Friday 10am');
});

test('mergeProjectInfo: approx_size_sqft only overwritten by an actual finite number', () => {
  let info = mergeProjectInfo({ approx_size_sqft: 1500 }, { approx_size_sqft: null });
  assert.equal(info.approx_size_sqft, 1500);
  info = mergeProjectInfo({ approx_size_sqft: 1500 }, { approx_size_sqft: 2200 });
  assert.equal(info.approx_size_sqft, 2200);
  info = mergeProjectInfo({ approx_size_sqft: null }, { approx_size_sqft: 'a lot' });
  assert.equal(info.approx_size_sqft, null);
});

// ─── analyzeSetupCallCoaching: LLM-call contract ───────────────────────────

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

test('analyzeSetupCallCoaching: returns null with no api key, or with < 3 segments', async () => {
  assert.equal(await analyzeSetupCallCoaching(null, 'm1', [{ speaker: 'Rep', text: 'hi' }]), null);
  assert.equal(await analyzeSetupCallCoaching('key', 'm1', []), null);
  assert.equal(await analyzeSetupCallCoaching('key', 'm1', [{ speaker: 'Rep', text: 'hi' }]), null);
});

test('analyzeSetupCallCoaching: returns setup_call mode shape (no stage/checklist), merges project_info', async (t) => {
  const llmResponse = {
    disc: { detected: 'I', confidence: 'high', emoji: '🦜', label: 'Influential (Parrot)', tip: 'Keep it warm and social.' },
    nudges: ['Lock in the visit day/time'],
    urgent: null,
    project_info: {
      customer_name: 'Jane Doe',
      customer_address: null,
      project_type: 'exterior repaint',
      scope_notes: 'front and back of house',
      approx_size_sqft: 1800,
      timeline_urgency: 'before winter',
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

  const segments = [
    { speaker: 'Rep', text: 'Hi, this is Alex from CertaPro, is this Jane?' },
    { speaker: 'Customer', text: 'Yes, I need my house exterior repainted before winter.' },
    { speaker: 'Rep', text: 'Great, does Thursday at 2pm work for an in-person visit?' },
    { speaker: 'Customer', text: 'Yes, Thursday at 2pm works.' },
  ];

  const result = await analyzeSetupCallCoaching('fake-key', 'meeting-1', segments, {});

  assert.equal(calls.length, 1);
  assert.equal(result.mode, 'setup_call');
  // The dedicated setup-call output shape must NOT carry stage/checklist —
  // those are the 11-step in-person walkthrough fields this mode replaces.
  assert.equal('stage' in result, false);
  assert.equal('checklist' in result, false);
  assert.equal(result.disc.detected, 'I');
  assert.deepEqual(result.nudges, ['Lock in the visit day/time']);
  assert.equal(result.urgent, null);
  assert.equal(result.project_info.customer_name, 'Jane Doe');
  assert.equal(result.project_info.project_type, 'exterior repaint');
  assert.equal(result.project_info.approx_size_sqft, 1800);
  assert.equal(result.project_info.appointment_set, true);
  assert.equal(result.project_info.appointment_date_time, 'Thursday at 2pm');
});

test('analyzeSetupCallCoaching: merges onto existingProjectInfo so earlier-confirmed facts survive', async (t) => {
  const llmResponse = {
    disc: { detected: 'D', confidence: 'medium', emoji: '🦅', label: 'Dominant (Eagle)', tip: 'Be direct.' },
    nudges: [],
    urgent: null,
    project_info: {
      customer_name: null, // not re-mentioned this pass
      customer_address: null,
      project_type: null,
      scope_notes: null,
      approx_size_sqft: null,
      timeline_urgency: null,
      budget_signal: 'mentioned wanting to stay under $8k',
      appointment_set: false, // not re-confirmed this pass either
      appointment_date_time: null,
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
    appointment_set: true, appointment_date_time: 'Thursday at 2pm', notes: null,
  };

  const segments = [
    { speaker: 'Rep', text: 'One more thing, what budget range did you have in mind?' },
    { speaker: 'Customer', text: 'We would like to stay under $8k if possible.' },
    { speaker: 'Rep', text: 'Got it, that is helpful.' },
  ];

  const result = await analyzeSetupCallCoaching('fake-key', 'meeting-1', segments, existing);

  assert.equal(result.project_info.customer_name, 'Jane Doe', 'must survive from existing');
  assert.equal(result.project_info.project_type, 'exterior repaint', 'must survive from existing');
  assert.equal(result.project_info.appointment_set, true, 'must stay true from existing');
  assert.equal(result.project_info.appointment_date_time, 'Thursday at 2pm', 'must survive from existing');
  assert.equal(result.project_info.budget_signal, 'mentioned wanting to stay under $8k', 'new fact must be added');
});

test('analyzeSetupCallCoaching: returns null on LLM/network failure', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  t.after(() => { global.fetch = originalFetch; });

  const segments = [
    { speaker: 'Rep', text: 'Hi there' },
    { speaker: 'Customer', text: 'Hello' },
    { speaker: 'Rep', text: 'How can I help?' },
  ];
  const result = await analyzeSetupCallCoaching('fake-key', 'meeting-1', segments, {});
  assert.equal(result, null);
});
