/**
 * discProfiles.js — aria_disc_style_lock_to_four_bird_profiles (2026-08-31)
 *
 * Single source of truth for the DISC "label" + "emoji" pair CertaPro
 * reps see in the coaching UI. Root cause of the "turtle" bug Gabe
 * reported: both DISC-producing paths (server.js's in-person/live-call
 * runCoachingAnalysis(), and coachingAnalysis.js's setup-call
 * normalizeSetupCallDisc()) previously trusted the LLM's raw `label`/
 * `emoji` JSON fields verbatim, with at most a `typeof === 'string'`
 * check. The LLM's `detected` field (D/I/S/C/unknown) IS constrained by
 * prompt guidance, but label/emoji were free text — so the model could
 * (and did) drift and invent an animal outside CertaPro's canonical
 * four-bird DISC set.
 *
 * Fix: label/emoji are now 100% DERIVED from `detected` via this
 * hardcoded lookup table, never passed through from the LLM. Only
 * `detected`, `confidence`, and `tip` still come from the LLM's raw
 * output. Both call sites must import from here — do not re-implement
 * this mapping locally, or the two paths will drift apart again.
 */

// Canonical CertaPro DISC → bird mapping. Exactly these four keys map to
// real label/emoji values; anything else (including the literal string
// "unknown", or any garbage the LLM invents for `detected`) falls back to
// empty strings, matching the existing "Waiting on data..." UI behavior
// for missing DISC data (see CoachingPanel.tsx's `hasDisc` check) — never
// a 5th animal, never a guessed default.
export const DISC_BIRD_PROFILES = Object.freeze({
  D: Object.freeze({ emoji: '🦅', label: 'Dominant (Eagle)' }),
  I: Object.freeze({ emoji: '🦜', label: 'Influential (Parrot)' }),
  S: Object.freeze({ emoji: '🕊️', label: 'Steady (Dove)' }),
  C: Object.freeze({ emoji: '🦉', label: 'Conscientious (Owl)' }),
});

const EMPTY_PROFILE = Object.freeze({ emoji: '', label: '' });

/**
 * Given the LLM's raw `detected` value, return the deterministic
 * { emoji, label } pair for that DISC style. Never trust/return any
 * emoji or label the caller may have received from the LLM directly.
 *
 * @param {unknown} detected - the LLM's raw `disc.detected` field
 * @returns {{ emoji: string, label: string }}
 */
export function resolveDiscProfile(detected) {
  if (typeof detected === 'string' && Object.prototype.hasOwnProperty.call(DISC_BIRD_PROFILES, detected)) {
    return DISC_BIRD_PROFILES[detected];
  }
  return EMPTY_PROFILE;
}
