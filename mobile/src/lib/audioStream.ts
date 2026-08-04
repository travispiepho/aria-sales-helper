/**
 * audioStream.ts — Chunked mic → 16kHz linear16 PCM → WebSocket streamer.
 *
 * BACKGROUND / WHY THIS SHAPE (read before changing):
 *
 * The web PWA (app/web/public/audio-processor.js) streams audio via a Web
 * Audio `AudioWorkletNode` that gets a live callback with every ~10ms of
 * Float32 samples, downsamples to 16kHz, converts to Int16, and posts each
 * 1024-sample buffer to the main thread, which sends it straight over the
 * WebSocket as a raw binary frame. There is no equivalent "live PCM tap"
 * API in React Native — confirmed by reading `expo-audio`'s full TypeScript
 * surface (`AudioModule.types.ts`) and native source for this SDK version
 * (~1.1.1, Expo 54/RN 0.81.5):
 *   - `AudioRecorder` (what you'd use to capture mic input) exposes only
 *     `record()` / `stop()` / `pause()` and a file `uri` — there is no
 *     `onAudioBuffer`/`onSample` event for the *recorder*.
 *   - `AudioPlayer` DOES have a live sample callback (`audioSampleUpdate` /
 *     `useAudioSampleListener`), but that's for *playback* sampling
 *     (visualizers etc.), not for mic capture. It cannot be pointed at a
 *     live microphone input.
 * So there is no way to get a continuous low-latency PCM stream out of
 * expo-audio's current JS API without a native module. The verified,
 * available alternative implemented here is a **chunked file-based**
 * approach: repeatedly (record for N ms → stop → read the resulting file's
 * raw PCM bytes → send over the WS → delete the temp file → immediately
 * start the next chunk). This is a legitimate, commonly used pattern for
 * expo-managed apps without ejecting to a custom native module, but it has
 * a real, inherent trade-off vs. the web app's approach: a small gap
 * (recorder stop/start + JS/file I/O round-trip, empirically expected to be
 * on the order of tens-to-low-hundreds of ms) between each chunk, during
 * which no audio is captured. This is NOT a bug in this implementation —
 * it's a structural limit of file-based chunked recording vs. a true
 * streaming tap, and should be validated/tuned on a real device.
 *
 * PLATFORM SPLIT — iOS vs Android (this is the key finding of this task):
 *
 * iOS: `expo-audio`'s `AudioRecorder` wraps `AVAudioRecorder`, which DOES
 * support linear PCM output directly (`AVFormatIDKey = kAudioFormatLinearPCM`,
 * i.e. `IOSOutputFormat.LINEARPCM`, combined with `AVLinearPCMBitDepthKey`,
 * `AVSampleRateKey`, `AVNumberOfChannelsKey`) — confirmed by reading
 * `expo-audio/ios/AudioUtils.swift`'s `createRecordingOptions()`, which maps
 * every one of these fields straight into the `AVAudioRecorder` settings
 * dict. Recording to a `.wav` file with these settings produces a real
 * PCM WAV file we can read and strip the header from — the exact format
 * (16kHz, mono, 16-bit linear16) the backend's Deepgram pipeline expects.
 *
 * Android: `expo-audio`'s `AudioRecorder` wraps `android.media.MediaRecorder`
 * (confirmed by reading `expo-audio/android/.../AudioRecorder.kt` +
 * `AudioRecords.kt`). `MediaRecorder`'s `OutputFormat` enum (`DEFAULT`,
 * `THREE_GPP`, `MPEG_4`, `AMR_NB`, `AMR_WB`, `AAC_ADTS`, `WEBM` — every value
 * `AndroidOutputFormat` in expo-audio's types maps to) has **no raw
 * PCM/WAV output option at all** — this is a real limitation of Android's
 * `MediaRecorder` API itself, not something expo-audio chose to omit. Every
 * format MediaRecorder can write is either a compressed codec (AAC/AMR) or
 * a container that requires demuxing. There is no way to get linear16 PCM
 * bytes out of `expo-audio`'s Android recorder without a custom native
 * module built on `android.media.AudioRecord` (the *other*, lower-level
 * Android audio API, which `expo-audio` does not currently wrap for
 * recording). Sending the AAC/3GP bytes this recorder actually produces to
 * the backend's raw-PCM-expecting Deepgram pipe would silently corrupt the
 * transcription for that meeting — so this module intentionally refuses to
 * start real streaming on Android rather than doing that.
 *
 * NOT verified against a real device from this sandbox (no physical iOS
 * device / Expo Go runtime available here) — see the accompanying report
 * (`memory/aria-mobile-audio-streaming-2026-08-04.md`) for exactly what was
 * and wasn't validated, and how.
 *
 * ROOT CAUSE FIX (2026-08-04, "mic may not have been recording" report):
 *
 * `expo-audio`'s native recorder refuses to actually record until the app
 * has called `setAudioModeAsync({ allowsRecording: true, ... })` — every
 * `AudioRecorder` starts with an internal `allowsRecording = false` flag
 * (confirmed in `expo-audio/ios/AudioRecorder.swift`: `var allowsRecording
 * = false`, and `record()`'s underlying `startRecording()` does `guard
 * allowsRecording else { throw RecordingDisabledException() }`). This flag
 * is flipped to `true` only inside `AudioModule.swift`'s `setAudioMode()`
 * handler for `setAudioModeAsync()`. Previously, this call was made for
 * the first time inside `ChunkedPcmStreamer.start()`, which only runs
 * *after* the WebSocket's `onopen` fires — i.e. after the user already
 * sees the green "Connected — listening" status and may reasonably start
 * talking immediately. `setAudioModeAsync()` is an async native bridge
 * call (it awaits `AVAudioSession.setCategory()` + `setActive()` under the
 * hood); doing it for the first time at that late point creates a real
 * window, of a length that has not been measured, between "user sees
 * listening" and "recorder can actually be told to record" — during which
 * anything said is not captured. This is a plausible root cause for the
 * exact symptom reported ("I'm guessing my microphone was not actually
 * recording yet"), independent of and in addition to the code-level
 * Android limitation documented above.
 *
 * Fix applied: session arming (`armRecordingSession()`, exported below) is
 * now called as early as possible — immediately after mic permission is
 * granted in `meeting.tsx`'s `handleStart()`, in parallel with meeting
 * creation and WS connection, well before `onopen` fires — instead of
 * being deferred until the streamer starts. `ChunkedPcmStreamer.start()`
 * still calls it too (memoized, so a repeat call is a cheap no-op) as a
 * defensive fallback for any other caller. This does not eliminate the
 * inherent per-chunk stop/start gap documented above, but it does remove
 * the "connected but audio-session-not-even-armed-yet" window, which is a
 * strictly worse and previously-unaccounted-for gap on top of that one.
 */

import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import {
  IOSOutputFormat,
  AudioQuality,
  setAudioModeAsync,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';

// Backend contract (verified by reading app/server/server.js's Deepgram
// connection params AND by a live wire-format test against the real
// production backend — see the report for the raw request/response
// evidence): 16kHz, mono, 16-bit signed little-endian linear PCM, sent as
// raw WebSocket binary frames (no extra header/framing per message).
export const TARGET_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

// How long each recorded chunk is before we stop/read/restart. Shorter =
// lower end-to-end transcription latency but more per-chunk stop/start
// overhead (and therefore more total audio lost to the inter-chunk gap).
// 1000ms is a reasonable starting point for a first real-device tuning
// pass; not device-tested.
const CHUNK_DURATION_MS = 1000;

export const STREAMING_SUPPORTED_PLATFORM = Platform.OS === 'ios';

const IOS_PCM_OPTIONS: RecordingOptions = {
  extension: '.wav',
  sampleRate: TARGET_SAMPLE_RATE,
  numberOfChannels: CHANNELS,
  bitRate: TARGET_SAMPLE_RATE * BIT_DEPTH * CHANNELS, // uncompressed PCM bit rate
  isMeteringEnabled: false,
  android: {
    // Never actually used for streaming (STREAMING_SUPPORTED_PLATFORM gates
    // that out) — filled in only so the shared useAudioRecorder() hook call
    // doesn't need a platform-conditional options shape.
    extension: '.3gp',
    outputFormat: 'default',
    audioEncoder: 'default',
  },
  ios: {
    extension: '.wav',
    sampleRate: TARGET_SAMPLE_RATE,
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    linearPCMBitDepth: BIT_DEPTH,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 128000,
  },
};

export function getStreamingRecorderOptions(): RecordingOptions {
  return IOS_PCM_OPTIONS;
}

// ---------------------------------------------------------------------------
// Recording-session arming — see "ROOT CAUSE" note in the module header for
// why this is a separate, early-called function rather than something done
// lazily inside ChunkedPcmStreamer.start().
// ---------------------------------------------------------------------------

let armPromise: Promise<void> | null = null;

/**
 * Activates the native audio session with recording enabled
 * (`setAudioModeAsync({ allowsRecording: true, ... })`).
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION, CALLED SEPARATELY AND EARLY:
 *
 * `expo-audio`'s native `AudioRecorder` (both iOS `AudioRecorder.swift` and
 * the shared module) gates every actual `record()` call behind an
 * `allowsRecording` flag that starts `false` for every newly-constructed
 * recorder (`var allowsRecording = false`, `AudioRecorder.swift` line 21)
 * and is flipped to `true` ONLY by `setAudioModeAsync({ allowsRecording:
 * true })` (`AudioModule.swift`'s `setAudioMode()`, which iterates
 * `registry.allRecorders` and sets `recorder.allowsRecording = true` on
 * each one). If `record()` is called while this flag is still `false`, the
 * native side throws `RecordingDisabledException` (`AudioRecorder.swift`
 * line 103-104, `guard allowsRecording else { throw
 * RecordingDisabledException() }`).
 *
 * Previously this call lived inside `ChunkedPcmStreamer.start()`, which is
 * only invoked from the WebSocket's `onopen` handler — i.e. AFTER the app
 * shows the green "Connected — listening" status and the user is likely to
 * start talking immediately. That put a real native async round-trip
 * (`setAudioModeAsync` awaits an `AVAudioSession.setCategory()` +
 * `setActive()` call) squarely on the critical path *after* the user
 * already sees "listening", and any speech during that window was never
 * captured (the previous chunk hadn't started recording yet). This is a
 * primary, code-level explanation for the reported "connected but mic
 * wasn't recording yet" symptom.
 *
 * Fix: call this as early as possible — right after mic permission is
 * granted, in parallel with meeting creation and WS connection, so the
 * audio session is already armed well before the WS even opens. It is
 * idempotent/memoized (safe to call multiple times; only does real work
 * once) so `ChunkedPcmStreamer.start()` can still call it defensively as a
 * safety net without re-paying the cost if the caller already armed it.
 */
export function armRecordingSession(): Promise<void> {
  if (!armPromise) {
    armPromise = setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
      shouldPlayInBackground: false,
    });
    // If arming fails, allow a future call to retry instead of caching a
    // permanent rejection.
    armPromise.catch(() => {
      armPromise = null;
    });
  }
  return armPromise;
}

/**
 * Parses a RIFF/WAVE file's byte content and returns just the raw PCM
 * sample bytes from its `data` chunk (stripping the RIFF header and any
 * other chunks, e.g. iOS sometimes writes metadata chunks after `data`).
 * Returns null if this doesn't look like a valid WAV file.
 */
export function extractPcmFromWav(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const start = offset + 8;
      const end = Math.min(start + size, bytes.length);
      return bytes.slice(start, end);
    }
    // Chunks are word-aligned (padded to even size).
    offset += 8 + size + (size % 2);
  }
  return null;
}

export type StreamerCallbacks = {
  onChunkSent?: (byteLength: number) => void;
  onError?: (message: string) => void;
};

/**
 * Imperative controller for the chunked record→read→send loop. Must be
 * constructed with an already-created `AudioRecorder` instance (from
 * `useAudioRecorder(getStreamingRecorderOptions())` in the component) so
 * its lifecycle stays tied to React's hook rules; this class only drives it.
 */
export class ChunkedPcmStreamer {
  private recorder: AudioRecorder;
  private ws: WebSocket;
  private callbacks: StreamerCallbacks;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(recorder: AudioRecorder, ws: WebSocket, callbacks: StreamerCallbacks = {}) {
    this.recorder = recorder;
    this.ws = ws;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (!STREAMING_SUPPORTED_PLATFORM) {
      this.callbacks.onError?.(
        'Live audio streaming is not yet supported on Android in this build ' +
          '(expo-audio/MediaRecorder has no raw-PCM output option on Android — see audioStream.ts header).'
      );
      return;
    }
    if (this.running) return;
    this.running = true;

    try {
      // Defensive: normally already armed by `armRecordingSession()` being
      // called earlier (right after mic permission grant, in parallel with
      // meeting creation / WS connect — see meeting.tsx's `handleStart()`).
      // Calling it again here is a cheap no-op (memoized) safety net in case
      // some future caller constructs a streamer without having done that.
      await armRecordingSession();
    } catch (err) {
      this.callbacks.onError?.(
        `Failed to configure audio session: ${err instanceof Error ? err.message : String(err)}`
      );
      this.running = false;
      return;
    }

    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // already surfaced via onError during the loop
      }
      this.loopPromise = null;
    }
    // Best-effort: make sure the recorder isn't left mid-recording.
    try {
      if (this.recorder.isRecording) {
        await this.recorder.stop();
      }
    } catch {
      // ignore — nothing more we can do here
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let uri: string | null = null;
      try {
        await this.recorder.prepareToRecordAsync();
        this.recorder.record();
        await sleep(CHUNK_DURATION_MS);
        if (!this.running) {
          // stop() was called while we were "recording" this chunk — finish
          // cleanly instead of sending a partial chunk after the WS closed.
          await this.recorder.stop();
          break;
        }
        await this.recorder.stop();
        uri = this.recorder.uri;
      } catch (err) {
        this.callbacks.onError?.(
          `Recording chunk failed: ${err instanceof Error ? err.message : String(err)}`
        );
        // Small backoff before retrying so a persistent failure doesn't spin
        // hot in a tight loop.
        await sleep(500);
        continue;
      }

      if (!uri) continue;

      const file = new File(uri);
      try {
        const bytes = await file.bytes();
        const pcm = extractPcmFromWav(bytes);
        if (pcm && pcm.length > 0 && this.ws.readyState === WebSocket.OPEN) {
          // Copy into a plain ArrayBuffer view (not a subarray sharing the
          // parent buffer) so the WebSocket send type matches RN's typings
          // and we don't risk sending unintended sibling bytes.
          const outBytes = new Uint8Array(pcm.length);
          outBytes.set(pcm);
          this.ws.send(outBytes.buffer);
          this.callbacks.onChunkSent?.(pcm.byteLength);
        } else if (!pcm) {
          this.callbacks.onError?.('Recorded chunk was not a valid PCM WAV file — skipped.');
        }
      } catch (err) {
        this.callbacks.onError?.(
          `Failed to read/send audio chunk: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        try {
          file.delete();
        } catch {
          // non-fatal — temp cache dir, OS will reclaim eventually
        }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
