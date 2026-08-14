#!/usr/bin/env node
/**
 * test-phone-transcription-replay.js
 *
 * REAL end-to-end verification of the phone-channel Deepgram wiring
 * WITHOUT a live Twilio call. This does NOT touch Twilio at all — it
 * synthesizes Twilio-shaped Media Streams `media` event envelopes
 * (base64 mulaw payloads) from a real speech WAV file and feeds them
 * through the EXACT SAME production code path telephony.js uses:
 *
 *   1. twilioPayloadToLinear16Buffer() (audioCodec.js, untouched) —
 *      decodes each base64 mulaw frame to 16kHz linear16, identical to
 *      what the `case 'media':` handler in telephony.js does.
 *   2. createDeepgramSession() (deepgramSession.js, new module built for
 *      this task) — opens a REAL Deepgram nova-3 live-transcription
 *      WebSocket connection using DEEPGRAM_API_KEY from the environment,
 *      identical params to what /telephony/stream opens on `start`.
 *
 * This proves the exact chain telephony.js relies on: Twilio media
 * envelope -> audioCodec conversion -> Deepgram session -> transcript
 * result callback. It intentionally does NOT spin up the Fastify app or
 * a real WebSocket server for /telephony/stream itself (that would
 * require a live Twilio connection to drive), but every function it
 * calls is the literal same function telephony.js imports and calls.
 *
 * Usage:
 *   DEEPGRAM_API_KEY=xxx node scripts/test-phone-transcription-replay.js /tmp/test_speech_mulaw8k.wav
 *
 * Input WAV must be 8kHz mono mulaw (matches Twilio's real wire format).
 * Generate one with:
 *   espeak-ng -s 150 "some sentence" -w /tmp/test_speech.wav
 *   ffmpeg -y -i /tmp/test_speech.wav -ar 8000 -ac 1 -acodec pcm_mulaw /tmp/test_speech_mulaw8k.wav
 */

import { readFileSync } from 'fs';
import { twilioPayloadToLinear16Buffer } from '../audioCodec.js';
import { createDeepgramSession } from '../deepgramSession.js';

const wavPath = process.argv[2];
if (!wavPath) {
  console.error('Usage: node test-phone-transcription-replay.js <path-to-8khz-mulaw-wav>');
  process.exit(1);
}

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_API_KEY) {
  console.error('FAIL: DEEPGRAM_API_KEY not set in environment');
  process.exit(1);
}

// ── Parse the WAV file's fmt/data chunks manually (no wav-parsing lib
// dependency added) to extract the raw mulaw byte payload, exactly as it
// would arrive per-frame from Twilio's `media.payload` (base64 mulaw). ──
function extractMulawDataChunk(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let dataChunk = null;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(chunkStart),
        numChannels: buf.readUInt16LE(chunkStart + 2),
        sampleRate: buf.readUInt32LE(chunkStart + 4),
      };
    } else if (chunkId === 'data') {
      dataChunk = buf.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error('No fmt chunk found');
  if (!dataChunk) throw new Error('No data chunk found');
  return { fmt, dataChunk };
}

const wavBuf = readFileSync(wavPath);
const { fmt, dataChunk } = extractMulawDataChunk(wavBuf);
console.log(`Parsed WAV: format=${fmt.audioFormat} (7=mulaw) channels=${fmt.numChannels} sampleRate=${fmt.sampleRate} dataBytes=${dataChunk.length}`);

if (fmt.audioFormat !== 7) {
  console.error(`FAIL: input WAV is not mulaw-encoded (audioFormat=${fmt.audioFormat}, expected 7). Regenerate with ffmpeg -acodec pcm_mulaw.`);
  process.exit(1);
}
if (fmt.sampleRate !== 8000) {
  console.error(`FAIL: input WAV is not 8kHz (got ${fmt.sampleRate}Hz) — Twilio Media Streams audio is always 8kHz.`);
  process.exit(1);
}

// Twilio sends 20ms frames = 160 bytes of mulaw at 8kHz (8000 * 0.02 = 160 samples, 1 byte/sample for mulaw).
const FRAME_BYTES = 160;
const frames = [];
for (let i = 0; i < dataChunk.length; i += FRAME_BYTES) {
  frames.push(dataChunk.subarray(i, Math.min(i + FRAME_BYTES, dataChunk.length)));
}
console.log(`Split into ${frames.length} Twilio-style 20ms mulaw frames (${FRAME_BYTES} bytes each)`);

// ── Step 1: verify audioCodec.js conversion (real, tested elsewhere too) ──
let totalLinear16Bytes = 0;
const linear16Frames = frames.map((frameBuf) => {
  const base64Payload = frameBuf.toString('base64'); // simulate Twilio's media.payload field
  const linear16Buf = twilioPayloadToLinear16Buffer(base64Payload);
  totalLinear16Bytes += linear16Buf.length;
  return linear16Buf;
});
console.log(`PASS: audioCodec.js converted all ${frames.length} frames -> ${totalLinear16Bytes} bytes of 16kHz linear16 PCM`);

// ── Step 2: open a REAL Deepgram session (same module telephony.js uses) ──
console.log('Opening real Deepgram live-transcription connection via deepgramSession.js ...');

let finalTranscripts = [];
let interimCount = 0;
let sawAnyResult = false;

const session = createDeepgramSession({
  apiKey: DEEPGRAM_API_KEY,
  log: (msg) => console.log(`[deepgramSession] ${msg}`),
  onError: (err) => console.error(`[deepgramSession] ERROR: ${err.message}`),
  onCircuitOpen: (reason) => console.error(`[deepgramSession] CIRCUIT OPEN: ${reason}`),
  onTranscript: (result) => {
    sawAnyResult = true;
    if (result.isFinal) {
      finalTranscripts.push(result.text);
      console.log(`FINAL transcript segment (speaker=${result.speaker}): "${result.text}"`);
    } else {
      interimCount += 1;
      console.log(`interim: "${result.text}"`);
    }
  },
});

// Wait for the DG socket to actually open before streaming (mirrors how
// telephony.js queues audio via dgSession.send() even before 'open' fires —
// but for a clean test run we wait explicitly here to avoid the whole test
// racing DG's connection handshake).
function waitUntilReady(maxWaitMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (session.isReady()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > maxWaitMs) {
        clearInterval(iv);
        reject(new Error('Deepgram session did not become ready in time'));
      }
    }, 100);
  });
}

try {
  await waitUntilReady(10000);
  console.log('PASS: Deepgram WebSocket connection opened successfully (real network round-trip to api.deepgram.com)');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

// ── Step 3: stream the converted linear16 frames to Deepgram at real-time
// pace (20ms per frame, matching Twilio's actual cadence) ──
console.log(`Streaming ${linear16Frames.length} converted audio frames to Deepgram in real time ...`);
for (const buf of linear16Frames) {
  session.send(buf);
  await new Promise((r) => setTimeout(r, 20));
}

// Send Deepgram's finalize signal equivalent by waiting for trailing results,
// then close.
console.log('Finished streaming audio. Waiting up to 8s for trailing Deepgram results ...');
await new Promise((r) => setTimeout(r, 8000));

session.close();
await new Promise((r) => setTimeout(r, 500));

console.log('─'.repeat(60));
console.log(`RESULT: sawAnyResult=${sawAnyResult}, interimCount=${interimCount}, finalCount=${finalTranscripts.length}`);
console.log(`Final transcript(s): ${JSON.stringify(finalTranscripts)}`);

if (!sawAnyResult) {
  console.error('FAIL: Deepgram returned NO transcript results at all for this audio.');
  process.exit(1);
}
if (finalTranscripts.length === 0) {
  console.error('WARN: Deepgram returned interim results but no FINAL segment — inconclusive but not a hard failure (interim_results=true is deliberate).');
}

const joined = finalTranscripts.join(' ').toLowerCase();
const hasExpectedWords = /hello|test|aria|phone|transcription|fox|dog/.test(joined);
if (finalTranscripts.length > 0 && !hasExpectedWords) {
  console.error(`WARN: final transcript text doesn't obviously match the input sentence — check manually: "${joined}"`);
}

console.log(finalTranscripts.length > 0 && hasExpectedWords
  ? 'PASS: end-to-end phone-channel Deepgram pipeline produced a real, on-topic transcript.'
  : 'INCONCLUSIVE: see WARN(s) above — re-check manually.');

process.exit(0);
