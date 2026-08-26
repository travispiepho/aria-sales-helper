import assert from 'node:assert/strict';
import {
  loadEnrolledVoicePrint,
  parseBooleanFlag,
  voiceFingerprintIdentificationPolicy,
} from '../voiceFingerprintIdentification.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(err);
  }
}

test('unset and empty values preserve existing enabled behavior', () => {
  assert.equal(parseBooleanFlag(undefined), true);
  assert.equal(parseBooleanFlag(null), true);
  assert.equal(parseBooleanFlag(''), true);
  assert.equal(parseBooleanFlag('   '), true);
});

test('explicit false strings parse false instead of using string truthiness', () => {
  for (const value of ['false', 'FALSE', ' false ', '0', 'no', 'off']) {
    assert.equal(parseBooleanFlag(value), false, `${JSON.stringify(value)} should disable`);
  }
});

test('explicit true strings preserve automatic identification', () => {
  for (const value of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
    assert.equal(parseBooleanFlag(value), true, `${JSON.stringify(value)} should enable`);
  }
});

test('disabled policy bypasses every automatic fingerprint stage but not manual or intro naming', () => {
  assert.deepEqual(voiceFingerprintIdentificationPolicy('false'), {
    automaticIdentification: false,
    loadEnrolledVoicePrint: false,
    accumulateMatchingAudio: false,
    runAutomaticMatchAndLock: false,
    runDriftUnlock: false,
    manualSpeakerLabeling: true,
    confirmedIntroductionNaming: true,
  });
});

await (async () => {
  try {
    let queryCalls = 0;
    const queryVoicePrint = async () => {
      queryCalls += 1;
      return { spectralCentroid: 123 };
    };

    const disabledResult = await loadEnrolledVoicePrint(
      voiceFingerprintIdentificationPolicy('false'),
      queryVoicePrint
    );
    assert.equal(disabledResult, null);
    assert.equal(queryCalls, 0, 'disabled state must not query enrolled voiceprints');

    const enabledResult = await loadEnrolledVoicePrint(
      voiceFingerprintIdentificationPolicy(undefined),
      queryVoicePrint
    );
    assert.deepEqual(enabledResult, { spectralCentroid: 123 });
    assert.equal(queryCalls, 1, 'unset/default-enabled state must preserve the lookup');
    console.log('  ok - disabled state bypasses DB lookup; unset state preserves it');
  } catch (err) {
    failures += 1;
    console.error('  FAIL - disabled state bypasses DB lookup; unset state preserves it');
    console.error(err);
  }
})();

test('enabled and unset policies preserve all prior automatic stages', () => {
  for (const value of [undefined, 'true']) {
    const policy = voiceFingerprintIdentificationPolicy(value);
    assert.equal(policy.automaticIdentification, true);
    assert.equal(policy.loadEnrolledVoicePrint, true);
    assert.equal(policy.accumulateMatchingAudio, true);
    assert.equal(policy.runAutomaticMatchAndLock, true);
    assert.equal(policy.runDriftUnlock, true);
    assert.equal(policy.manualSpeakerLabeling, true);
    assert.equal(policy.confirmedIntroductionNaming, true);
  }
});

if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('All voice-fingerprint identification feature-flag tests passed.');
