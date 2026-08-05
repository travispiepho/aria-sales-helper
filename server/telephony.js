/**
 * telephony.js — Twilio phone-call bridging scaffold ("Aria Phone Channel",
 * formerly "Skill Two"). SCAFFOLDING ONLY.
 *
 * No Twilio credentials exist yet (Troy is signing up for Account SID, Auth
 * Token, TwiML App SID, and a phone number). Every route in this module is
 * gated behind presence of the Twilio env vars and returns a clear 503
 * "not configured" response rather than crashing or attempting a live call.
 *
 * Wire-format references (verified live against Twilio's real public docs
 * on 2026-08-04, NOT invented):
 *   - <Stream>/<Connect><Stream> TwiML noun:
 *     https://www.twilio.com/docs/voice/twiml/stream
 *   - Media Streams WebSocket message envelope (connected/start/media/stop):
 *     https://www.twilio.com/docs/voice/media-streams/websocket-messages
 *
 * Confirmed message shapes used below:
 *   {"event":"connected","protocol":"Call","version":"1.0.0"}
 *   {"event":"start","sequenceNumber":"1","start":{"streamSid":...,"callSid":...,
 *     "tracks":["inbound"],"mediaFormat":{"encoding":"audio/x-mulaw","sampleRate":8000,"channels":1},
 *     "customParameters":{...}},"streamSid":"..."}
 *   {"event":"media","sequenceNumber":"N","media":{"track":"inbound","chunk":"N",
 *     "timestamp":"ms","payload":"<base64 mulaw>"},"streamSid":"..."}
 *   {"event":"stop","sequenceNumber":"N","stop":{"accountSid":...,"callSid":...},"streamSid":"..."}
 *
 * Architecture (per memory/skill-two-phone-extension-spec-2026-08-03.md and
 * memory/telephony-api-comparison-2026-08-03.md):
 *   - "Aria calls you" rep workflow: Aria's backend places an outbound call
 *     to the rep's own cell number; once the rep answers, TwiML <Dial>s the
 *     customer, and a <Start><Stream>/<Connect><Stream> forks call audio to
 *     this module's WebSocket route.
 *   - Twilio Media Streams audio is 8kHz mulaw — bridged to the existing
 *     16kHz linear16 pipeline via audioCodec.js (built + unit-tested
 *     standalone, see scripts/test-audio-codec.js).
 *   - Data model: per the "one continuous timeline" mandate, a phone call is
 *     just another `meetings` row with `channel = 'phone'` and a `call_sid`
 *     column — NOT a parallel/disconnected table. See
 *     migrations/2026-08-04-phone-channel-columns.sql (proposed, NOT applied
 *     — see report).
 *   - Consent: state law on call-recording consent varies (one-party vs
 *     two-party). See the REQUIRED-DECISION block below — do not ship without
 *     addressing it. This module only scaffolds an obvious placeholder; the
 *     actual legal/consent-flow design is explicitly NOT solved here.
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

/** Whether all required Twilio credentials are present. */
export function isConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

function notConfiguredReply(reply) {
  return reply.code(503).send({
    error: 'Twilio not configured on server',
    detail: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER are not set. ' +
      'This is expected until Troy completes Twilio signup — routes are scaffolded and ' +
      'will activate automatically once the env vars are present.',
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ⚠️ REQUIRED PRE-LAUNCH DECISION — CALL RECORDING CONSENT (DO NOT SHIP
// WITHOUT ADDRESSING THIS): call recording consent law varies by state
// (one-party vs two-party/all-party consent — see
// memory/skill-two-phone-extension-spec-2026-08-03.md Section 4.3 for the
// full grounded legal survey and the "Always Disclose" recommended default).
// This scaffold hardcodes a placeholder <Say> disclosure below so the shape
// exists and can never be silently skipped on a "tracked" call — but the
// actual required decisions (script wording sign-off, who owns legal
// approval, disclosure_method/disclosure_played_at audit-log columns, retention
// policy) are NOT solved here. Do not remove this comment block or ship this
// TwiML to a real customer call without a real legal/compliance sign-off.
// ─────────────────────────────────────────────────────────────────────────
const CONSENT_DISCLOSURE_TWIML_SAY =
  'This call is being recorded for quality assurance and sales coaching purposes. ' +
  'By staying on the line, you agree to this recording.';
// TODO(legal-sign-off): confirm this exact wording, the disclosure trigger
// point (must play before ANY substantive conversation per the spec), and
// the audit-log fields (disclosure_method, disclosure_played_at,
// disclosure_confirmed_by, disclosure_audio_segment_ref, consent_state) —
// see spec Section 4.3 for the full checklist. None of that audit logging
// is implemented yet; this constant is a placeholder demonstrating WHERE it
// plugs into the TwiML, not a finished consent flow.

/**
 * Register telephony routes on the given Fastify instance. Mirrors the
 * exact registration style already used in server.js for other route groups
 * — call this once from server.js with `await registerTelephonyRoutes(fastify, { pool })`.
 *
 * All routes below are env-gated; when Twilio isn't configured they return
 * 503 (HTTP routes) or close the socket immediately with a clear reason
 * (WS route) — nothing crashes, nothing attempts a live Twilio API call.
 */
export async function registerTelephonyRoutes(fastify, { pool, registerMeetingSocket, unregisterMeetingSocket } = {}) {
  // ── POST /telephony/voice — inbound-call voice webhook (TwiML response) ──
  // This is the URL you'd configure on the Twilio phone number / TwiML App
  // as the Voice webhook. Twilio POSTs call metadata (CallSid, From, To,
  // etc.) as application/x-www-form-urlencoded; Fastify's default JSON body
  // parser won't parse that automatically — a real implementation needs a
  // urlencoded content-type parser registered (not added here, since Twilio
  // isn't configured yet and adding a global content-type parser is exactly
  // the kind of "minimal, isolated" scaffolding vs "touching shared setup"
  // tradeoff this task asked to keep minimal — flagged for whoever wires
  // real credentials in).
  fastify.post('/telephony/voice', async (request, reply) => {
    if (!isConfigured()) return notConfiguredReply(reply);

    // ⚠️ SCAFFOLDING — not a live call path. Real implementation would:
    //   1. Look up / create a `meetings` row (channel='phone', call_sid=CallSid)
    //      linked to the right customer/opportunity per the "one continuous
    //      timeline" data model (see migrations/2026-08-04-phone-channel-columns.sql).
    //   2. Return TwiML that plays the consent disclosure, then either
    //      <Dial>s the customer (rep-answered-first flow) or <Start><Stream>s
    //      to this module's /telephony/stream WS route for capture.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${CONSENT_DISCLOSURE_TWIML_SAY}</Say>
  <Start>
    <Stream url="wss://${request.hostname}/telephony/stream" />
  </Start>
  <Say>Connecting your call now.</Say>
</Response>`;
    return reply.type('text/xml').send(twiml);
  });

  // ── POST /telephony/status-callback — call-status-callback webhook stub ──
  // Configured via <Stream statusCallback="..."> or the Call resource's own
  // StatusCallback — Twilio POSTs {AccountSid, CallSid, StreamSid, StreamName,
  // StreamEvent, StreamError?, Timestamp} (form-encoded) on stream/call
  // lifecycle events. Scaffold just acknowledges; real implementation should
  // update the corresponding `meetings` row's status/ended_at.
  fastify.post('/telephony/status-callback', async (request, reply) => {
    if (!isConfigured()) return notConfiguredReply(reply);
    fastify.log.info('Twilio status callback received (scaffold, not yet processed)');
    return reply.code(200).send({ ok: true });
  });

  // ── GET /telephony/stream — Twilio Media Streams WebSocket handler ──────
  // Mirrors the existing /meetings/:meetingId/audio pattern in server.js
  // (same ring-buffer/forwarding shape) but consumes Twilio's JSON-enveloped
  // base64 mulaw frames instead of raw binary PCM, and converts audio via
  // audioCodec.js before forwarding onward (to Deepgram, once wired) and
  // running the same rep-voiceprint / speaker-relabel logic used in-person.
  fastify.get('/telephony/stream', { websocket: true }, async (socket, request) => {
    if (!isConfigured()) {
      socket.send(JSON.stringify({ type: 'error', error: 'Twilio not configured on server' }));
      socket.close(1011, 'Twilio not configured');
      return;
    }

    fastify.log.info('Twilio Media Stream WS connected (scaffold)');

    let streamSid = null;
    let callSid = null;

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case 'connected':
          // {"event":"connected","protocol":"Call","version":"1.0.0"}
          fastify.log.info(`Twilio stream protocol=${msg.protocol} version=${msg.version}`);
          break;

        case 'start': {
          // Confirmed shape: start.streamSid, start.callSid, start.tracks,
          // start.mediaFormat={encoding:"audio/x-mulaw",sampleRate:8000,channels:1},
          // start.customParameters
          streamSid = msg.start?.streamSid;
          callSid = msg.start?.callSid;
          fastify.log.info(`Twilio stream started: streamSid=${streamSid} callSid=${callSid}`);

          // ⚠️ SCAFFOLDING — real implementation would:
          //   1. Look up the `meetings` row for this callSid (created in the
          //      /telephony/voice webhook handler above).
          //   2. registerMeetingSocket(meetingId, socket) — same call already
          //      used by the in-person WS handler, so coaching broadcasts work
          //      identically over the phone channel.
          //   3. Open a Deepgram connection identical to the in-person path
          //      (same dgUrl/model/params already used in server.js) — NOT
          //      duplicated here; a real implementation should factor that
          //      connection logic into a shared helper rather than copy-paste,
          //      which is a refactor intentionally deferred (out of this
          //      task's "minimal changes to working code" scope).
          //   4. If PYANNOTE_API_KEY is set, also start a
          //      PyannoteStreamClient (voicePrint.js) in parallel for
          //      diarization + eventual /identify calls — mirrors the
          //      alongside-Deepgram pattern noted in voicePrint.js.
          break;
        }

        case 'media': {
          // Confirmed shape: media.track, media.chunk, media.timestamp,
          // media.payload (base64 mulaw, 8kHz, mono)
          if (msg.media?.payload) {
            // ⚠️ SCAFFOLDING — conversion function is real/tested
            // (audioCodec.js), but nothing downstream consumes the output
            // yet since there's no live Deepgram/pyannoteAI connection wired
            // for this route (Twilio isn't configured, and wiring a second
            // full Deepgram connection here would duplicate ~150 lines of
            // the in-person handler — deferred, see note in `start` above).
            // This line demonstrates the exact call site where that
            // conversion plugs in:
            //   const linear16Buf = twilioPayloadToLinear16Buffer(msg.media.payload);
            //   dgSocket.send(linear16Buf); // once a Deepgram connection exists for this call
          }
          break;
        }

        case 'stop':
          // Confirmed shape: stop.accountSid, stop.callSid
          fastify.log.info(`Twilio stream stopped: streamSid=${streamSid}`);
          if (unregisterMeetingSocket) {
            // unregisterMeetingSocket(meetingId, socket); // once meetingId is resolved above
          }
          break;

        case 'dtmf':
        case 'mark':
          // Not needed for capture-only MVP; present in the real protocol
          // (bidirectional streams only) — no-op here.
          break;

        default:
          fastify.log.warn(`Unknown Twilio Media Stream event: ${msg.event}`);
      }
    });

    socket.on('close', () => {
      fastify.log.info(`Twilio Media Stream WS closed: streamSid=${streamSid}`);
    });

    socket.on('error', (err) => {
      fastify.log.error('Twilio Media Stream WS error:', err.message);
    });
  });
}
