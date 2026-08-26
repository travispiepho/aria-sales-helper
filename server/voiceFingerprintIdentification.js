/**
 * Server-side policy for the enrolled-rep voice-fingerprint matcher.
 *
 * This deliberately controls only automatic fingerprint lookup, audio
 * accumulation, matching/locking, and drift-unlocking. Manual speaker labels
 * and the confirmed name-introduction flow are separate and stay enabled.
 */

export function parseBooleanFlag(value, defaultValue = true) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function voiceFingerprintIdentificationPolicy(value) {
  const automaticIdentification = parseBooleanFlag(value, true);
  return Object.freeze({
    automaticIdentification,
    loadEnrolledVoicePrint: automaticIdentification,
    accumulateMatchingAudio: automaticIdentification,
    runAutomaticMatchAndLock: automaticIdentification,
    runDriftUnlock: automaticIdentification,
    manualSpeakerLabeling: true,
    confirmedIntroductionNaming: true,
  });
}

/**
 * Resolve enrolled features only when automatic identification is enabled.
 * Keeping the query behind this boundary makes the disabled-state DB bypass
 * deterministic and directly testable without opening an audio socket.
 */
export async function loadEnrolledVoicePrint(policy, queryVoicePrint) {
  if (!policy.loadEnrolledVoicePrint) return null;
  return queryVoicePrint();
}
