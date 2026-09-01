import assert from 'node:assert/strict';
import test from 'node:test';
import { DISC_BIRD_PROFILES, resolveDiscProfile } from '../discProfiles.js';
import { normalizeSetupCallDisc } from '../coachingAnalysis.js';

// ─── aria_disc_style_lock_to_four_bird_profiles (2026-08-31) ──────────────
// Root cause: both DISC-producing paths (server.js's live-call
// runCoachingAnalysis(), coachingAnalysis.js's setup-call
// normalizeSetupCallDisc()) used to trust the LLM's raw label/emoji JSON
// output with at most a typeof === 'string' check — nothing validated it
// against CertaPro's canonical four-bird set, so the model could (and did,
// per Gabe's report) invent an animal outside D/Eagle, I/Parrot, S/Dove,
// C/Owl (e.g. "turtle"). These tests prove label/emoji are now derived
// 100% from `detected`, never LLM-passthrough, regardless of what a
// misbehaving LLM response tries to put in label/emoji.

// ─── resolveDiscProfile: the shared lookup table itself ───────────────────

test('resolveDiscProfile: every canonical DISC letter maps to exactly the CertaPro bird set', () => {
  assert.deepEqual(resolveDiscProfile('D'), { emoji: '🦅', label: 'Dominant (Eagle)' });
  assert.deepEqual(resolveDiscProfile('I'), { emoji: '🦜', label: 'Influential (Parrot)' });
  assert.deepEqual(resolveDiscProfile('S'), { emoji: '🕊️', label: 'Steady (Dove)' });
  assert.deepEqual(resolveDiscProfile('C'), { emoji: '🦉', label: 'Conscientious (Owl)' });
});

test('resolveDiscProfile: "unknown" and any non-canonical/garbage detected value falls back to empty, never a 5th animal', () => {
  assert.deepEqual(resolveDiscProfile('unknown'), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile('turtle'), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile('d'), { emoji: '', label: '' }); // case-sensitive — lowercase is not a valid key
  assert.deepEqual(resolveDiscProfile(''), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile(null), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile(undefined), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile(42), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile({ malicious: true }), { emoji: '', label: '' });
});

test('resolveDiscProfile: does not leak Object.prototype members as a false-positive match', () => {
  // toString/constructor/etc are inherited by every string via its wrapper
  // object's prototype chain in naive lookups — guard against that class
  // of bug explicitly, since DISC_BIRD_PROFILES uses a plain object.
  assert.deepEqual(resolveDiscProfile('toString'), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile('constructor'), { emoji: '', label: '' });
  assert.deepEqual(resolveDiscProfile('hasOwnProperty'), { emoji: '', label: '' });
});

test('DISC_BIRD_PROFILES: frozen, exactly four canonical keys, no accidental extra entries', () => {
  assert.deepEqual(Object.keys(DISC_BIRD_PROFILES).sort(), ['C', 'D', 'I', 'S']);
  assert.equal(Object.isFrozen(DISC_BIRD_PROFILES), true);
});

// ─── normalizeSetupCallDisc: THE regression test — bad LLM output is forced back to canonical ───

test('normalizeSetupCallDisc: REGRESSION — a "bad" LLM response claiming Turtle/🐢 for a D-detected prospect is forced to Eagle/🦅', () => {
  // This is exactly the failure mode Gabe reported live: the LLM's
  // constrained `detected` field correctly says "D", but its free-text
  // label/emoji fields have drifted to a non-canonical animal. Before this
  // fix, normalizeSetupCallDisc() passed disc.label/disc.emoji straight
  // through with only a typeof check, so "Turtle"/"🐢" would have reached
  // the rep's screen unchanged.
  const badLlmDisc = { detected: 'D', confidence: 'medium', emoji: '🐢', label: 'Turtle', tip: 'Be direct.' };
  const result = normalizeSetupCallDisc(badLlmDisc);

  assert.equal(result.detected, 'D'); // detected passes through untouched — it's the constrained field
  assert.equal(result.confidence, 'medium'); // confidence passes through untouched
  assert.equal(result.tip, 'Be direct.'); // tip passes through untouched
  assert.equal(result.emoji, '🦅'); // emoji is FORCED to the canonical Eagle emoji, not the LLM's 🐢
  assert.equal(result.label, 'Dominant (Eagle)'); // label is FORCED to the canonical Eagle label, not "Turtle"
  assert.notEqual(result.emoji, badLlmDisc.emoji);
  assert.notEqual(result.label, badLlmDisc.label);
});

test('normalizeSetupCallDisc: bad LLM label/emoji is overridden for every canonical detected letter', () => {
  const cases = [
    { detected: 'D', llmLabel: 'Turtle', llmEmoji: '🐢', wantLabel: 'Dominant (Eagle)', wantEmoji: '🦅' },
    { detected: 'I', llmLabel: 'Peacock', llmEmoji: '🦚', wantLabel: 'Influential (Parrot)', wantEmoji: '🦜' },
    { detected: 'S', llmLabel: 'Sloth', llmEmoji: '🦥', wantLabel: 'Steady (Dove)', wantEmoji: '🕊️' },
    { detected: 'C', llmLabel: 'Fox', llmEmoji: '🦊', wantLabel: 'Conscientious (Owl)', wantEmoji: '🦉' },
  ];
  for (const c of cases) {
    const result = normalizeSetupCallDisc({ detected: c.detected, confidence: 'high', emoji: c.llmEmoji, label: c.llmLabel, tip: 't' });
    assert.equal(result.label, c.wantLabel, `detected=${c.detected} label should be forced to canonical`);
    assert.equal(result.emoji, c.wantEmoji, `detected=${c.detected} emoji should be forced to canonical`);
  }
});

test('normalizeSetupCallDisc: detected="unknown" with LLM-invented label/emoji falls back to empty, matching "Waiting on data..." UI behavior', () => {
  const result = normalizeSetupCallDisc({ detected: 'unknown', confidence: 'low', emoji: '🐢', label: 'Turtle', tip: '' });
  assert.equal(result.detected, 'unknown');
  assert.equal(result.emoji, '');
  assert.equal(result.label, '');
});

test('normalizeSetupCallDisc: existing correct behavior for detected=D/I/S/C is unchanged from a rep-facing perspective (same emoji/label text as before)', () => {
  // These are the exact strings the pre-fix code returned when the LLM
  // happened to behave correctly — confirms the fix doesn't regress the
  // happy path, only closes the drift hole.
  assert.deepEqual(
    normalizeSetupCallDisc({ detected: 'D', confidence: 'medium', emoji: '🦅', label: 'Dominant (Eagle)', tip: 'Be direct.' }),
    { detected: 'D', confidence: 'medium', emoji: '🦅', label: 'Dominant (Eagle)', tip: 'Be direct.' }
  );
  assert.deepEqual(
    normalizeSetupCallDisc({ detected: 'I', confidence: 'high', emoji: '🦜', label: 'Influential (Parrot)', tip: 'Keep it warm and social.' }),
    { detected: 'I', confidence: 'high', emoji: '🦜', label: 'Influential (Parrot)', tip: 'Keep it warm and social.' }
  );
});

test('normalizeSetupCallDisc: malformed disc object (non-string detected, missing fields) degrades to empty/null safely', () => {
  assert.deepEqual(normalizeSetupCallDisc(null), { detected: null, confidence: null, emoji: '', label: '', tip: '' });
  assert.deepEqual(normalizeSetupCallDisc(undefined), { detected: null, confidence: null, emoji: '', label: '', tip: '' });
  assert.deepEqual(normalizeSetupCallDisc({ detected: 123 }), { detected: null, confidence: null, emoji: '', label: '', tip: '' });
});
