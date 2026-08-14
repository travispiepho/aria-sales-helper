/**
 * deepgramSession.js — standalone Deepgram live-transcription connection
 * helper for the Aria Phone Channel (Twilio Media Streams).
 *
 * ⚠️ INTENTIONAL DUPLICATION — READ BEFORE "CLEANING THIS UP":
 * server.js's in-person `/meetings/:meetingId/audio` WebSocket handler
 * (search for "Open Deepgram streaming connection" in server.js, ~line
 * 3369 as of this writing) already opens a nova-3 + diarization Deepgram
 * connection with the same model/encoding parameters used below. This
 * module is a DELIBERATE, SEPARATE re-implementation of just the
 * connect/reconnect/close/transcript-parsing plumbing — it does NOT import
 * from or modify server.js in any way.
 *
 * Per this task's explicit hard rule, the in-person handler is proven in
 * production and must not be touched or refactored in this pass, even
 * though that means real logic (Deepgram connection lifecycle, reconnect
 * backoff, circuit breaker, final/interim transcript parsing) is
 * duplicated between server.js and this file instead of shared. That is
 * accepted debt, not an oversight. A follow-up pass should extract a truly
 * shared module (e.g. this file's connection core, generalized) and have
 * BOTH server.js's in-person route and telephony.js's phone route consume
 * it — but that refactor touches the working in-person pipeline and is
 * explicitly out of scope here.
 *
 * Scope difference from the in-person handler (deliberate simplification,
 * not a missed feature): this module does NOT implement rep-voiceprint
 * matching, speaker de-duplication/merging, drift re-verification, mid-call
 * name-introduction suggestions, or the live rebuttal teleprompter. Those
 * are in-person-flow features layered on top of the base Deepgram
 * connection in server.js. The phone channel's stated objective for this
 * pass is "transcript_segments rows persisted + live transcript events
 * broadcast, at parity with the in-person flow" — i.e. the transcription
 * pipeline itself, not every coaching feature built on top of it. Adding
 * those phone-side later is a separate, additive task.
 *
 * Wire params mirrored from the in-person connection (same Deepgram model
 * behavior, adjusted only for the fact that Twilio audio arrives already
 * converted to 16kHz linear16 by audioCodec.js before it reaches this
 * module — same encoding/sample_rate the in-person handler uses):
 *   model: nova-3
 *   smart_format: true
 *   diarize_model: latest
 *   interim_results: true
 *   utterance_end_ms: 1000
 *   encoding: linear16
 *   sample_rate: 16000
 *   channels: 1
 */

import WebSocket from 'ws';

const DG_RECONNECT_BASE_MS = 1000;
const DG_RECONNECT_MAX_MS = 30000;
const DG_CIRCUIT_MAX_FAILURES = 8;
const DG_CIRCUIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build the Deepgram live-transcription WS URL with the same params as the
 * in-person handler (see module docstring).
 */
export function buildDeepgramUrl() {
  return 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    diarize_model: 'latest',
    interim_results: 'true',
    utterance_end_ms: '1000',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  }).toString();
}

/**
 * Parse a single Deepgram 'Results' WS message into a normalized shape, or
 * return null if the message isn't a usable transcript result (e.g.
 * Metadata/UtteranceEnd events, or a Results event with empty transcript).
 *
 * Exported standalone (not inlined in the class below) so it can be unit
 * tested directly against captured/synthetic Deepgram payloads without
 * needing a live socket — see scripts/test-deepgram-session.js.
 *
 * @returns {{ isFinal: boolean, text: string, speaker: number } | null}
 */
export function parseDeepgramResult(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (msg.type !== 'Results') return null;

  const alt = msg?.channel?.alternatives?.[0];
  if (!alt) return null;

  const text = (alt.transcript || '').trim();
  if (!text) return null;

  const words = alt.words || [];
  const speaker = words.length > 0 && words[0].speaker !== undefined ? words[0].speaker : 0;

  return {
    isFinal: msg.is_final === true,
    text,
    speaker,
    words,
  };
}

/**
 * Create a self-contained Deepgram live-transcription session.
 *
 * Reconnect/circuit-breaker behavior mirrors the in-person handler's
 * hardening (exponential backoff 1s→30s, circuit breaker after 8 failures
 * within a 5-minute window) — same constants, independently implemented
 * per the duplication note above.
 *
 * @param {object} opts
 * @param {string} opts.apiKey — DEEPGRAM_API_KEY
 * @param {(result: {isFinal: boolean, text: string, speaker: number, words: any[]}) => void} opts.onTranscript
 *   Called for every non-empty transcript result (both interim and final —
 *   caller checks `isFinal`).
 * @param {(reason: string) => void} [opts.onCircuitOpen] — called once if
 *   the reconnect circuit breaker trips (transcription permanently
 *   degraded for this session).
 * @param {(err: Error) => void} [opts.onError]
 * @param {(code: number) => void} [opts.onClose] — called on every close
 *   (including ones that will reconnect); NOT called again after the
 *   session's own .close() is invoked.
 * @param {(msg: string) => void} [opts.log]
 */
export function createDeepgramSession({ apiKey, onTranscript, onCircuitOpen, onError, onClose, log }) {
  const logFn = log || (() => {});
  const dgUrl = buildDeepgramUrl();

  let dgSocket = null;
  let dgReady = false;
  const audioQueue = [];
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let circuitOpen = false;
  const dgFailureTimestamps = [];

  function connect() {
    if (closed || circuitOpen) return;

    dgSocket = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    dgSocket.on('open', () => {
      dgReady = true;
      reconnectAttempts = 0;
      dgFailureTimestamps.length = 0;
      logFn('deepgramSession: connected');
      const queued = audioQueue.splice(0);
      queued.forEach((buf) => {
        if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(buf);
      });
    });

    dgSocket.on('message', (data) => {
      const result = parseDeepgramResult(data);
      if (!result) return;
      try {
        onTranscript && onTranscript(result);
      } catch (err) {
        logFn(`deepgramSession: onTranscript handler threw: ${err.message}`);
      }
    });

    dgSocket.on('close', (code) => {
      dgReady = false;
      logFn(`deepgramSession: closed (code=${code})`);
      if (onClose) {
        try { onClose(code); } catch { /* ignore handler errors */ }
      }
      if (closed) return;

      const now = Date.now();
      dgFailureTimestamps.push(now);
      while (dgFailureTimestamps.length && now - dgFailureTimestamps[0] > DG_CIRCUIT_WINDOW_MS) {
        dgFailureTimestamps.shift();
      }

      if (dgFailureTimestamps.length >= DG_CIRCUIT_MAX_FAILURES) {
        circuitOpen = true;
        const reason = `${dgFailureTimestamps.length} reconnect failures within ${DG_CIRCUIT_WINDOW_MS / 1000}s`;
        logFn(`deepgramSession: circuit breaker OPEN (${reason})`);
        if (onCircuitOpen) {
          try { onCircuitOpen(reason); } catch { /* ignore handler errors */ }
        }
        return;
      }

      const delay = Math.min(DG_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), DG_RECONNECT_MAX_MS);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(connect, delay);
    });

    dgSocket.on('error', (err) => {
      logFn(`deepgramSession: WS error: ${err.message}`);
      if (onError) {
        try { onError(err); } catch { /* ignore handler errors */ }
      }
    });
  }

  connect();

  return {
    /** Send a linear16 PCM buffer (or queue it if the DG socket isn't open yet). */
    send(buf) {
      if (closed) return;
      if (dgReady && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(buf);
      } else {
        const totalBuffered = audioQueue.reduce((s, b) => s + b.byteLength, 0);
        if (totalBuffered < 960_000) audioQueue.push(Buffer.from(buf));
      }
    },
    /** True once the underlying Deepgram WS is open and accepting audio. */
    isReady() {
      return dgReady;
    },
    /** Gracefully close the Deepgram connection and stop reconnecting. */
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        try {
          dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
          setTimeout(() => dgSocket.terminate(), 2000);
        } catch {
          dgSocket.terminate();
        }
      } else if (dgSocket) {
        try { dgSocket.terminate(); } catch { /* ignore */ }
      }
    },
  };
}
