/**
 * voicePrint.js — pyannoteAI client wrapper (voice fingerprinting / speaker ID)
 *
 * SCAFFOLDING ONLY — no PYANNOTE_API_KEY exists yet (Troy is signing up).
 * Every exported function is gated behind `isConfigured()`. When the key is
 * absent, calls resolve to a clear `{ configured: false }` result instead of
 * throwing, so nothing else in the app breaks.
 *
 * API shapes below were verified live against pyannoteAI's real public docs
 * on 2026-08-04 (https://docs.pyannote.ai — OpenAPI/AsyncAPI specs fetched
 * directly), NOT invented. Sources, per endpoint:
 *   - POST /v1/voiceprint        https://docs.pyannote.ai/api-reference/voiceprint.md
 *   - POST /v1/identify          https://docs.pyannote.ai/api-reference/identify.md
 *   - GET  /v1/jobs/{jobId}      https://docs.pyannote.ai/api-reference/get-job.md
 *   - POST /v1/live (streaming)  https://docs.pyannote.ai/api-reference/create-stream.md
 *   - WS stream protocol         https://docs.pyannote.ai/api-reference/streaming.md
 *   - Auth (Bearer API key)      https://docs.pyannote.ai/authentication.md
 *
 * ⚠️ CONFIRM BEFORE GO-LIVE (once a real key exists): re-run a live request
 * against each endpoint and diff the actual response against what's modeled
 * here — docs can drift, and none of this has been exercised against a real
 * pyannoteAI account. Treat every response shape below as "best available
 * documentation, not yet verified against a live call."
 *
 * Architectural notes (per memory/voice-fingerprinting-comparison-2026-08-03.md
 * and memory/skill-two-phone-extension-spec-2026-08-03.md):
 *   - pyannoteAI runs ALONGSIDE Deepgram, not instead of it. Deepgram remains
 *     the transcription engine; pyannoteAI supplies diarization + true
 *     voiceprint identity matching.
 *   - The streaming endpoint (/v1/live + WS) gives DIARIZATION events only
 *     (diarization_speaker_start/end with a stable per-session SPEAKER_NN
 *     label) — it does NOT resolve identity live. Identity resolution is a
 *     separate, asynchronous /v1/identify (or /v1/voiceprint enrollment)
 *     call your app triggers per newly-seen speaker slot, then remaps using
 *     the state machine in speakerRelabel.js. pyannoteAI does not auto-relabel
 *     anything — that logic is entirely ours to build (done in
 *     speakerRelabel.js, independent of this module).
 *   - HARD COST RULE (per skill-two spec): resolve identity via /v1/identify
 *     ONCE per newly-detected speaker index per call, cache the result, and
 *     reuse it for the rest of the call. Never call /identify per turn —
 *     20s minimum billing per job means per-turn calls could be a 10-50x
 *     cost blowout for zero accuracy benefit. This module does not enforce
 *     that on its own (it's a stateless HTTP client) — the caller (the WS
 *     handler scaffold in server.js, and eventually telephony.js) MUST cache
 *     per session and only call submitIdentify() once per newly-resolved
 *     slot. See the "identify caching" example in the module-level jsdoc of
 *     speakerRelabel.js.
 */

const PYANNOTE_API_BASE = 'https://api.pyannote.ai';

function apiKey() {
  return process.env.PYANNOTE_API_KEY || null;
}

/**
 * Whether pyannoteAI is usable right now. Everything else in this module
 * checks this before attempting any network call.
 */
export function isConfigured() {
  return !!apiKey();
}

function notConfiguredResult(extra = {}) {
  return { configured: false, error: 'PYANNOTE_API_KEY not set — pyannoteAI is not configured', ...extra };
}

async function pyannoteRequest(method, path, body) {
  const key = apiKey();
  if (!key) return notConfiguredResult();

  const res = await fetch(`${PYANNOTE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body, ignore */ }

  if (!res.ok) {
    return {
      configured: true,
      ok: false,
      status: res.status,
      error: json?.message || `pyannoteAI request failed with status ${res.status}`,
      raw: json,
    };
  }

  return { configured: true, ok: true, ...json };
}

/**
 * Submit an audio URL to be turned into a reusable voiceprint blob.
 * POST /v1/voiceprint — real shape confirmed via docs (2026-08-04).
 * Request:  { url, model?: 'precision-2', webhook?, webhookStatusOnly? }
 * Response (200): { jobId, status, warning? } — async job, poll getJob().
 * pyannoteAI auto-deletes job outputs 24h after completion — the caller
 * MUST persist the resulting `voiceprint` (base64 string) into our own DB
 * (voice_print_samples, see migrations/2026-08-04-voice-print-multi-sample.sql)
 * once the job succeeds; pyannoteAI is not a long-term voiceprint store.
 *
 * @param {{ audioUrl: string, webhook?: string }} params
 */
export async function createVoiceprint({ audioUrl, webhook } = {}) {
  if (!isConfigured()) return notConfiguredResult();
  if (!audioUrl) return { configured: true, ok: false, error: 'audioUrl is required' };
  return pyannoteRequest('POST', '/v1/voiceprint', {
    url: audioUrl,
    model: 'precision-2',
    ...(webhook ? { webhook } : {}),
  });
}

/**
 * Submit a diarization + speaker-identification job against a list of known
 * voiceprints. POST /v1/identify — real shape confirmed via docs (2026-08-04).
 *
 * Request: {
 *   url,                          // audio to identify
 *   voiceprints: [{ label, voiceprint }],  // label must NOT start with "SPEAKER_"
 *   matching?: { exclusive?: boolean, threshold?: number (0-100) },
 *   numSpeakers?, minSpeakers?, maxSpeakers?,
 *   model?: 'precision-2', webhook?, webhookStatusOnly?
 * }
 * Response (200): { jobId, status, warning? } — async job, poll getJob().
 * On success (via getJob), output.identification is an array of
 * { diarizationSpeaker, match (label or null), confidence? }.
 *
 * @param {{ audioUrl: string, voiceprints: {label:string, voiceprint:string}[], threshold?: number }} params
 */
export async function submitIdentify({ audioUrl, voiceprints, threshold } = {}) {
  if (!isConfigured()) return notConfiguredResult();
  if (!audioUrl) return { configured: true, ok: false, error: 'audioUrl is required' };
  if (!Array.isArray(voiceprints) || voiceprints.length === 0) {
    return { configured: true, ok: false, error: 'voiceprints array is required (min 1)' };
  }
  return pyannoteRequest('POST', '/v1/identify', {
    url: audioUrl,
    voiceprints,
    model: 'precision-2',
    ...(threshold !== undefined ? { matching: { threshold } } : {}),
  });
}

/**
 * Poll a job (voiceprint, identify, or diarization) by id.
 * GET /v1/jobs/{jobId} — real shape confirmed via docs (2026-08-04).
 * Response includes { jobId, status, createdAt, updatedAt, output? }.
 * `output` is only present once status === 'succeeded', and pyannoteAI
 * deletes it 24h after completion — persist anything you need past that
 * window into our own DB immediately upon success.
 */
export async function getJob(jobId) {
  if (!isConfigured()) return notConfiguredResult();
  if (!jobId) return { configured: true, ok: false, error: 'jobId is required' };
  return pyannoteRequest('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
}

/**
 * Create a new live streaming diarization session.
 * POST /v1/live — real shape confirmed via docs (2026-08-04).
 * Response: { id, url } — `url` is a single-use wss:// URL (token embedded
 * in the query string) that a client connects to and streams raw audio.
 */
export async function createLiveStream() {
  if (!isConfigured()) return notConfiguredResult();
  return pyannoteRequest('POST', '/v1/live', {});
}

/**
 * PyannoteStreamClient — thin wrapper around the pyannoteAI streaming
 * diarization WebSocket (confirmed protocol, docs.pyannote.ai/api-reference/streaming).
 *
 * Wire protocol (confirmed, not invented):
 *   - Client → server: binary frames, raw PCM float32 little-endian
 *     (pcm_f32le), 16kHz mono, 100ms per chunk (1600 samples / 6400 bytes).
 *   - Client → server: {"type":"end_of_stream"} JSON text frame when done.
 *   - Server → client: {"type":"diarization_speaker_start","data":{"timestamp":<sec>,"speaker":"SPEAKER_00"}}
 *   - Server → client: {"type":"diarization_speaker_end","data":{"timestamp":<sec>,"speaker":"SPEAKER_00"}}
 *   - Server → client: {"type":"error","message":"..."}
 *
 * This class is a NO-OP shell if PYANNOTE_API_KEY is unset: start() resolves
 * immediately without opening any socket, and pushAudio()/end() are safe
 * no-ops. This lets call sites (server.js's WS audio handler, and
 * telephony.js) invoke it unconditionally without their own env-var branch,
 * though today's call sites still guard it for clarity/log-noise reasons.
 *
 * ⚠️ NOT YET EXERCISED against a live pyannoteAI stream — the WS URL/token
 * mechanics and exact reconnect semantics should be validated against a real
 * account before this is trusted in production. This mirrors (structurally,
 * not by code-sharing) the reconnect-with-backoff pattern already used for
 * the Deepgram WS connection in server.js's /meetings/:meetingId/audio route.
 */
export class PyannoteStreamClient {
  constructor({ onSpeakerStart, onSpeakerEnd, onError, log } = {}) {
    this.onSpeakerStart = onSpeakerStart || (() => {});
    this.onSpeakerEnd = onSpeakerEnd || (() => {});
    this.onError = onError || (() => {});
    this.log = log || (() => {});
    this.ws = null;
    this.ready = false;
    this.configured = isConfigured();
  }

  /** Resolve a live stream session and open the WebSocket. No-op if unconfigured. */
  async start() {
    if (!this.configured) {
      this.log('PyannoteStreamClient.start(): not configured, no-op');
      return { configured: false };
    }

    const stream = await createLiveStream();
    if (!stream.ok) {
      this.onError(stream.error || 'failed to create pyannoteAI live stream');
      return stream;
    }

    // Lazy import so this module has zero hard dependency on `ws` for
    // consumers who never configure pyannoteAI.
    const { default: WebSocket } = await import('ws');
    this.ws = new WebSocket(stream.url);

    this.ws.on('open', () => {
      this.ready = true;
      this.log(`pyannoteAI stream connected (id=${stream.id})`);
    });

    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'diarization_speaker_start') this.onSpeakerStart(msg.data);
      else if (msg.type === 'diarization_speaker_end') this.onSpeakerEnd(msg.data);
      else if (msg.type === 'error') this.onError(msg.message);
    });

    this.ws.on('error', (err) => this.onError(err.message));
    this.ws.on('close', () => { this.ready = false; });

    return { configured: true, ok: true, id: stream.id };
  }

  /**
   * Push a chunk of 16kHz mono Int16 PCM audio (the same format the existing
   * Deepgram pipeline already works with). Converts to pcm_f32le internally
   * per pyannoteAI's documented wire format. No-op if unconfigured or not
   * yet connected.
   */
  pushAudio(int16Chunk) {
    if (!this.configured || !this.ready || !this.ws) return;
    const float32 = new Float32Array(int16Chunk.length);
    for (let i = 0; i < int16Chunk.length; i++) float32[i] = int16Chunk[i] / 32768;
    this.ws.send(Buffer.from(float32.buffer));
  }

  /** Signal end-of-stream and close. No-op if unconfigured. */
  end() {
    if (!this.configured || !this.ws) return;
    try {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: 'end_of_stream' }));
      }
    } catch { /* ignore */ }
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
