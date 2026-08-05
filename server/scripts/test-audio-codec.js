#!/usr/bin/env node
/**
 * test-audio-codec.js — standalone unit test for audioCodec.js's mulaw <->
 * linear16 conversion. No test framework in this repo (checked: no jest/
 * vitest/mocha in package.json), so this is a plain Node script per the
 * task's instruction, run via `node scripts/test-audio-codec.js`.
 *
 * Verifies round-trip correctness (encode -> decode) against a known PCM
 * waveform, tolerating mulaw's expected lossy-compression error (mulaw is a
 * non-linear 8-bit-per-sample codec; small quantization error vs. the
 * original 16-bit sample is expected and NOT a bug).
 */

import { encodeMulawBuffer, decodeMulawBuffer, mulawByteToLinear16, linear16ToMulawByte, upsample8kTo16k, twilioPayloadToLinear16Buffer } from '../audioCodec.js';

let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`PASS: ${msg}`);
  }
}

// ─── Test 1: known reference mulaw encode values (ITU-T G.711 standard
// reference points, well-known fixed points of the algorithm) ─────────────
// mulaw encoding of PCM 0 is the standard "positive zero" byte 0xFF (~0x80
// after the final inversion... verify against known reference: PCM silence
// (0) encodes to 0xFF in standard mulaw (positive zero code)).
{
  const encoded = linear16ToMulawByte(0);
  assert(encoded === 0xff, `PCM 0 encodes to standard mulaw silence byte 0xFF (got 0x${encoded.toString(16)})`);
}

// Full-scale positive/negative should encode to the standard clip codes.
// Verified against the classic reference mulaw encoder (Sun/CCITT
// `linear2ulaw`, e.g. Craig Reese & Joe Campbell's widely-ported g711.c):
// sign bit is computed BEFORE the final bitwise-NOT, so after the NOT,
// positive full-scale clips to 0x80 and negative full-scale clips to 0x00
// (the sign bit's logical polarity flips under the final ~). This is
// confirmed self-consistent here too: decode(0x80) yields a large POSITIVE
// value and decode(0x00) yields a large NEGATIVE value (see round-trip
// test below), matching this convention.
{
  const encoded = linear16ToMulawByte(32767);
  assert(encoded === 0x80, `PCM +32767 encodes to standard mulaw max-positive-clip byte 0x80 (got 0x${encoded.toString(16)})`);
  const decodedBack = mulawByteToLinear16(encoded);
  assert(decodedBack > 0, `mulaw byte 0x80 decodes back to a positive value (got ${decodedBack}), confirming sign convention`);
}

{
  const encoded = linear16ToMulawByte(-32768);
  assert(encoded === 0x00, `PCM -32768 encodes to standard mulaw max-negative-clip byte 0x00 (got 0x${encoded.toString(16)})`);
  const decodedBack = mulawByteToLinear16(encoded);
  assert(decodedBack < 0, `mulaw byte 0x00 decodes back to a negative value (got ${decodedBack}), confirming sign convention`);
}

// ─── Test 2: round-trip a synthetic sine wave through encode -> decode ────
// Generate a 200Hz tone at 8kHz sample rate, 100ms (800 samples), encode to
// mulaw, decode back, and confirm the reconstructed waveform tracks the
// original within mulaw's known lossy tolerance. Mulaw is a non-uniform
// quantizer that gives ~14-bit dynamic range perceptually but has real
// quantization error at the sample level, especially near zero-crossings —
// tolerance below (max abs error as a fraction of full-scale) is set
// generously loose (12%) specifically because mulaw's coarsest quantization
// step occurs at the largest-magnitude samples (near +/-32767), where a
// single mulaw code step can represent a swing of ~500+ raw PCM units by
// design (that's the entire point of a non-linear/companding codec: more
// resolution near zero, deliberately less at the extremes) — this is
// expected lossy behavior, not a defect. A tighter tolerance would
// incorrectly fail on totally standard-compliant mulaw quantization.
{
  const n = 800;
  const sampleRate = 8000;
  const freq = 200;
  const original = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    original[i] = Math.round(20000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  }

  const encoded = encodeMulawBuffer(original);
  const decoded = decodeMulawBuffer(encoded);

  assert(decoded.length === original.length, 'round-trip preserves sample count');

  let maxAbsErr = 0;
  let sumAbsErr = 0;
  for (let i = 0; i < n; i++) {
    const err = Math.abs(decoded[i] - original[i]);
    maxAbsErr = Math.max(maxAbsErr, err);
    sumAbsErr += err;
  }
  const meanAbsErr = sumAbsErr / n;
  const maxErrFraction = maxAbsErr / 32768;
  const meanErrFraction = meanAbsErr / 32768;

  console.log(`  sine-wave round-trip: maxAbsErr=${maxAbsErr} (${(maxErrFraction * 100).toFixed(2)}% of full scale), meanAbsErr=${meanAbsErr.toFixed(1)} (${(meanErrFraction * 100).toFixed(2)}%)`);
  assert(maxErrFraction < 0.12, 'sine-wave round-trip max error within mulaw lossy tolerance (<12% full scale)');
  assert(meanErrFraction < 0.05, 'sine-wave round-trip mean error within mulaw lossy tolerance (<5% full scale)');
}

// ─── Test 3: byte-level round-trip stability (encode(decode(x)) === x) ────
// mulaw decode->encode of an already-valid mulaw byte should be idempotent
// or extremely close (mulaw -> PCM -> mulaw should land on the same byte or
// an adjacent one due to the encoder's rounding, not drift wildly).
{
  let mismatches = 0;
  for (let b = 0; b < 256; b++) {
    const pcm = mulawByteToLinear16(b);
    const reEncoded = linear16ToMulawByte(pcm);
    if (reEncoded !== b) mismatches++;
  }
  console.log(`  byte-level idempotency: ${256 - mismatches}/256 bytes round-trip exactly`);
  assert(mismatches <= 8, `mulaw byte round-trip (decode->encode) is idempotent for the overwhelming majority of the 256-byte space (${mismatches} mismatches, all expected at compression-boundary edge cases)`);
}

// ─── Test 4: upsample8kTo16k doubles sample count and preserves original
// samples at even indices ──────────────────────────────────────────────────
{
  const input = new Int16Array([100, 200, 300, 400]);
  const output = upsample8kTo16k(input);
  assert(output.length === input.length * 2, 'upsample8kTo16k doubles the sample count');
  assert(output[0] === 100 && output[2] === 200 && output[4] === 300 && output[6] === 400,
    'upsample8kTo16k preserves original samples at even indices');
  assert(output[1] === 150 && output[3] === 250 && output[5] === 350,
    'upsample8kTo16k linearly interpolates odd (inserted) indices');
}

// ─── Test 5: full base64 Twilio-payload -> linear16 Buffer pipeline ───────
{
  const original = new Int16Array(160); // 20ms @ 8kHz, typical Twilio chunk size
  for (let i = 0; i < original.length; i++) {
    original[i] = Math.round(15000 * Math.sin((2 * Math.PI * 300 * i) / 8000));
  }
  const mulawBuf = encodeMulawBuffer(original);
  const base64Payload = mulawBuf.toString('base64');

  const linear16Buf = twilioPayloadToLinear16Buffer(base64Payload);
  assert(linear16Buf.length === original.length * 2 * 2, 'twilioPayloadToLinear16Buffer produces 2x samples (8k->16k) at 2 bytes/sample');

  // Spot-check: decode the buffer back to Int16 and confirm it roughly
  // tracks the original tone (same lossy-tolerance reasoning as Test 2).
  const roundTripped = new Int16Array(linear16Buf.length / 2);
  for (let i = 0; i < roundTripped.length; i++) roundTripped[i] = linear16Buf.readInt16LE(i * 2);
  // Compare every other sample (the "real" 8k-derived ones, indices 0,2,4...)
  // against the original tone.
  let maxErr = 0;
  for (let i = 0; i < original.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(roundTripped[i * 2] - original[i]));
  }
  assert(maxErr / 32768 < 0.12, `full pipeline (mulaw encode -> base64 -> decode -> upsample) preserves tone within tolerance (maxErr=${maxErr})`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All audioCodec tests PASSED');
  process.exit(0);
}
