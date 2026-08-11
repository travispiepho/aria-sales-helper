/**
 * voiceEnrollment.ts — On-device voice-sample recording + feature extraction
 * for the mobile "Voice Recognition" profile section.
 *
 * PORT NOTES (2026-08-10, ported from app/web/src/pages/ProfilePage.tsx's
 * voice-enrollment flow, per Gabe's request):
 *
 * Web records via `getUserMedia()` + a Web Audio `AnalyserNode` polled at
 * ~60fps to collect Float32 time-domain PCM samples directly in memory,
 * then flattens them and calls `extractVoiceFeatures()` (see
 * `src/lib/voiceFeatures.ts`, ported byte-for-byte in this same task).
 * There is no browser `MediaRecorder`/`AnalyserNode` equivalent in React
 * Native — this module is the mobile-appropriate replacement, built on the
 * SAME `expo-audio` recorder + WAV-decoding pieces this app already uses
 * for live meeting audio streaming (`src/lib/audioStream.ts`), not a new
 * audio stack:
 *
 *   1. Uses the EXISTING `getStreamingRecorderOptions()` (16kHz, mono,
 *      16-bit signed little-endian linear PCM, `.wav` extension) — the
 *      exact same on-device recording format already verified against the
 *      backend's Deepgram pipe for live meetings. This is a single
 *      continuous ~30s recording (not the meeting screen's short chunked
 *      loop), because a voice-enrollment sample is short enough to record
 *      as one file and process once, unlike an open-ended live meeting.
 *   2. Uses the EXISTING `extractPcmFromWav()` (audioStream.ts) to strip
 *      the RIFF/WAVE header and get the raw 16-bit PCM sample bytes.
 *   3. Converts those Int16 LE bytes to a normalized `Float32Array`
 *      (`int16PcmBytesToFloat32`, below) — the exact input type
 *      `extractVoiceFeatures()` expects (see voiceFeatures.ts: it takes a
 *      `Float32Array` of samples in -1..1 range, no other assumptions about
 *      *how* those samples were produced). Web's `AnalyserNode` already
 *      hands back exactly this Float32 -1..1 shape; converting from Int16
 *      PCM is the correct, format-matching way to reproduce that same
 *      input contract from a WAV file's raw bytes instead of guessing.
 *   4. Runs the SAME `extractVoiceFeatures()` algorithm (ported verbatim
 *      into `voiceFeatures.ts`) to get the same `VoiceFeatures` shape the
 *      backend already stores/scores (see app/server/voiceFeatures.js —
 *      the backend's own copy of this identical algorithm) and the same
 *      shape `POST /api/profile/voice-print` already accepts (confirmed by
 *      reading `app/server/server.js`'s handler: `const { features,
 *      duration_ms } = request.body` — no shape validation beyond
 *      truthiness, so this mobile-produced object round-trips through the
 *      exact same code path web's does).
 *
 * PLATFORM LIMITATION (same root cause as audioStream.ts's streaming split,
 * carried over unchanged here — not a new gap introduced by this task):
 * Android's `expo-audio` recorder is backed by `android.media.MediaRecorder`,
 * which has NO raw PCM/WAV output option (every output format is a
 * compressed codec or a container requiring demuxing) — confirmed by
 * reading `expo-audio/android/.../AudioRecorder.kt` (see audioStream.ts's
 * header for the full citation). Attempting to feed AAC/3GP bytes through
 * `extractPcmFromWav()`/`int16PcmBytesToFloat32()` would silently produce a
 * garbage feature vector (a corrupt/meaningless voice print), not a clear
 * error — worse than not enrolling at all. So voice enrollment reuses
 * `audioStream.ts`'s existing `STREAMING_SUPPORTED_PLATFORM` gate (iOS-only
 * for now) and refuses to record on Android with a clear, explicit error
 * instead. This is the same trade-off already made (and documented) for
 * live meeting audio streaming, applied consistently here — not a new,
 * separately-invented restriction.
 *
 * NOT verified against a real device from this sandbox — no physical iOS
 * device or Expo Go runtime available here. What COULD be verified without
 * one: TypeScript compiles clean against `expo-audio`'s actual typed API
 * surface (no stubs), and the WAV-decode → Int16→Float32 → feature-vector
 * → JSON-POST data path was traced end-to-end against the real
 * `app/server/server.js` handler code (see this file's and
 * `(tabs)/profile.tsx`'s doc comments, and the task report).
 */

import { File } from 'expo-file-system';
import { type AudioRecorder } from 'expo-audio';

import {
  armRecordingSession,
  extractPcmFromWav,
  getStreamingRecorderOptions,
  STREAMING_SUPPORTED_PLATFORM,
  TARGET_SAMPLE_RATE,
} from '@/lib/audioStream';
import { extractVoiceFeatures, VoiceFeatures } from '@/lib/voiceFeatures';

// Mirrors web's ProfilePage.tsx `ENROLL_DURATION_MS` exactly — same 30s
// sample length, same backend expectations (voice_prints.duration_ms is
// just stored/displayed, not validated against a fixed value server-side,
// but keeping parity with web's UX/copy ("Record Voice Sample (30s)")).
export const ENROLL_DURATION_MS = 30000;

// Mirrors web's post-extraction guard: `features.frame_count < 10` — see
// ProfilePage.tsx's `stopAndSave()`. Re-exported here so the profile screen
// doesn't need to duplicate the magic number.
export const MIN_FRAME_COUNT = 10;

// Same iOS-only constraint as live meeting streaming — see file header.
export const ENROLLMENT_SUPPORTED_PLATFORM = STREAMING_SUPPORTED_PLATFORM;

export function getEnrollmentRecorderOptions() {
  return getStreamingRecorderOptions();
}

/**
 * Converts raw 16-bit signed little-endian PCM bytes (as produced by
 * `extractPcmFromWav()`) into a normalized Float32Array in the -1..1 range
 * — the exact input shape `extractVoiceFeatures()` expects (see
 * voiceFeatures.ts; this matches what web's Web Audio `AnalyserNode`
 * hands back natively via `getFloatTimeDomainData()`).
 */
export function int16PcmBytesToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true); // little-endian, matches audioStream.ts's recording options
    out[i] = int16 / 32768;
  }
  return out;
}

export interface EnrollmentResult {
  features: VoiceFeatures;
  durationMs: number;
}

/**
 * Imperative controller for a single voice-enrollment recording. Must be
 * constructed with an already-created `AudioRecorder` instance (from
 * `useAudioRecorder(getEnrollmentRecorderOptions())` in the component),
 * same pattern as `ChunkedPcmStreamer` in audioStream.ts.
 */
export class VoiceEnrollmentRecorder {
  private recorder: AudioRecorder;

  constructor(recorder: AudioRecorder) {
    this.recorder = recorder;
  }

  async start(): Promise<void> {
    if (!ENROLLMENT_SUPPORTED_PLATFORM) {
      throw new Error(
        'Voice enrollment recording is not yet supported on Android in this build ' +
          '(expo-audio/MediaRecorder has no raw-PCM output option on Android — see voiceEnrollment.ts header).'
      );
    }
    // Same "arm before record" requirement as live meeting streaming — see
    // audioStream.ts's armRecordingSession() doc for why this must happen
    // before record() is called.
    await armRecordingSession();
    await this.recorder.prepareToRecordAsync();
    this.recorder.record();
  }

  /**
   * Stops the in-progress recording, reads the resulting WAV file, and
   * extracts voice features. Returns null if nothing usable was captured
   * (e.g. stop() called with no active recording, or an empty/invalid WAV).
   */
  async stopAndExtract(): Promise<EnrollmentResult | null> {
    if (!this.recorder.isRecording) return null;
    await this.recorder.stop();
    const uri = this.recorder.uri;
    if (!uri) return null;

    const file = new File(uri);
    try {
      const bytes = await file.bytes();
      const pcmBytes = extractPcmFromWav(bytes);
      if (!pcmBytes || pcmBytes.length === 0) return null;

      const floatSamples = int16PcmBytesToFloat32(pcmBytes);
      const features = extractVoiceFeatures(floatSamples);
      // 16-bit mono PCM at TARGET_SAMPLE_RATE: 2 bytes/sample.
      const durationMs = Math.round((pcmBytes.length / 2 / TARGET_SAMPLE_RATE) * 1000);

      return { features, durationMs };
    } finally {
      try {
        file.delete();
      } catch {
        // non-fatal — temp cache dir, OS will reclaim eventually (same as audioStream.ts)
      }
    }
  }

  /** Best-effort abort without extracting — used when the user navigates away mid-recording. */
  async cancel(): Promise<void> {
    try {
      if (this.recorder.isRecording) {
        await this.recorder.stop();
      }
      const uri = this.recorder.uri;
      if (uri) {
        try {
          new File(uri).delete();
        } catch {
          // non-fatal
        }
      }
    } catch {
      // best-effort only
    }
  }
}
