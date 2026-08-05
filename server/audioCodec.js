/**
 * audioCodec.js — mulaw (G.711 μ-law) ⇄ linear16 PCM conversion + 8kHz→16kHz
 * upsampling, for bridging Twilio Media Streams audio (8kHz mulaw, base64
 * JSON envelopes) into the existing Deepgram-facing pipeline, which expects
 * 16kHz mono linear16 PCM (see server.js's /meetings/:meetingId/audio route,
 * which sends raw Int16 PCM straight through to Deepgram's
 * `encoding=linear16&sample_rate=16000` streaming endpoint).
 *
 * Pure DSP/math — no network, no vendor dependency, fully unit-testable
 * standalone (see scripts/test-audio-codec.js).
 *
 * mulaw decode/encode tables follow the standard G.711 μ-law algorithm
 * (ITU-T G.711), the same algorithm used by every telephony codec including
 * Twilio's — this is a well-known, standardized bit-exact transform, not a
 * vendor-specific format.
 */

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

// ─── mulaw byte -> linear16 sample (decode) ──────────────────────────────────
// Standard ITU-T G.711 μ-law decode table approach (bitwise, not table-based,
// for clarity + zero precomputed-table drift risk).
export function mulawByteToLinear16(muByte) {
  muByte = ~muByte & 0xff;
  const sign = muByte & 0x80;
  const exponent = (muByte >> 4) & 0x07;
  const mantissa = muByte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  if (sign !== 0) sample = -sample;
  // Clamp to int16 range defensively (decode should already stay in range).
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// ─── linear16 sample -> mulaw byte (encode) ──────────────────────────────────
// Standard ITU-T G.711 μ-law encode algorithm.
export function linear16ToMulawByte(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const muByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muByte;
}

/**
 * Decode a Buffer of mulaw bytes (8kHz, mono — Twilio's fixed format) into a
 * Int16Array of linear16 PCM samples at the SAME sample rate (8kHz). Does
 * not upsample — call upsample8kTo16k() separately if needed.
 */
export function decodeMulawBuffer(mulawBuffer) {
  const out = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    out[i] = mulawByteToLinear16(mulawBuffer[i]);
  }
  return out;
}

/**
 * Encode a Int16Array of linear16 PCM samples (8kHz) into a Buffer of mulaw
 * bytes. Inverse of decodeMulawBuffer(), used only for round-trip testing
 * and for defensive symmetry (Twilio bidirectional streams could in
 * principle need this for sending audio back, not required for MVP capture-
 * only use).
 */
export function encodeMulawBuffer(int16Array) {
  const out = Buffer.alloc(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = linear16ToMulawByte(int16Array[i]);
  }
  return out;
}

/**
 * Upsample 8kHz mono Int16 PCM to 16kHz mono Int16 PCM via simple linear
 * interpolation (2x). This is a pragmatic, dependency-free upsampler —
 * adequate for STT input (Deepgram/pyannoteAI both tolerate non-brick-wall
 * anti-aliasing on a 2x upsample far better than, say, playback audio would
 * need). If STT accuracy on real Twilio call audio turns out to need a
 * proper polyphase/sinc resampler once this goes live, swap the
 * implementation here without touching call sites.
 */
export function upsample8kTo16k(int16At8k) {
  const n = int16At8k.length;
  if (n === 0) return new Int16Array(0);
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const cur = int16At8k[i];
    const next = i + 1 < n ? int16At8k[i + 1] : cur;
    out[i * 2] = cur;
    out[i * 2 + 1] = Math.round((cur + next) / 2);
  }
  return out;
}

/**
 * Convenience: full pipeline from a raw Twilio `media.payload` base64 mulaw
 * string straight to a Buffer of 16kHz linear16 PCM bytes, ready to forward
 * to the same Deepgram-facing socket.send() the in-person pipeline already
 * uses. Byte order: little-endian Int16, matching Node's default
 * Int16Array/DataView usage and Deepgram's `encoding=linear16` expectation.
 */
export function twilioPayloadToLinear16Buffer(base64Payload) {
  const mulawBuffer = Buffer.from(base64Payload, 'base64');
  const pcm8k = decodeMulawBuffer(mulawBuffer);
  const pcm16k = upsample8kTo16k(pcm8k);
  const out = Buffer.alloc(pcm16k.length * 2);
  for (let i = 0; i < pcm16k.length; i++) {
    out.writeInt16LE(pcm16k[i], i * 2);
  }
  return out;
}
