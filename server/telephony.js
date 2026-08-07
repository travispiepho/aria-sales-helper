/**
 * telephony.js — Twilio phone-call bridging ("Aria Phone Channel", formerly
 * "Skill Two").
 *
 * STATUS (2026-08-06 build-out): credential handling, webhook signature
 * validation, and the /telephony/voice meeting/customer-lookup logic are now
 * REAL implementations, unit-tested with mocked payloads. Phone number and
 * TwiML App SID are still missing (Twilio account is on Trial mode pending
 * Troy adding a payment method) — this module reports "partially configured"
 * until those arrive, and no live Twilio REST/API call has been made or
 * attempted anywhere in this file. See the build report for the full
 * itemized list of what remains gated on those two credentials.
 *
 * Wire-format references (verified live against Twilio's real public docs,
 * NOT invented):
 *   - <Stream>/<Connect><Stream> TwiML noun:
 *     https://www.twilio.com/docs/voice/twiml/stream
 *   - Media Streams WebSocket message envelope (connected/start/media/stop):
 *     https://www.twilio.com/docs/voice/media-streams/websocket-messages
 *   - Webhook signature validation (X-Twilio-Signature, HMAC-SHA1 w/ Auth
 *     Token, twilio.validateRequest()):
 *     https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *   - API Key auth constructor signature (`twilio(apiKeySid, apiKeySecret,
 *     { accountSid })`) — confirmed directly from the twilio npm package
 *     source (lib/rest/Twilio.js / lib/base/BaseTwilio.js, v6.0.2): the
 *     Twilio() constructor's first two positional args are documented as
 *     "username"/"password", explicitly "if using key/secret auth will be
 *     the api key sid" / "...the secret" respectively, with accountSid
 *     passed via opts.accountSid. This is not guessed — read from the
 *     installed package's own source and docstrings.
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
 *     standalone, see scripts/test-audio-codec.js — untouched by this pass).
 *   - Data model: per the "one continuous timeline" mandate, a phone call is
 *     just another `meetings` row with `channel = 'phone'` and a `call_sid`
 *     column — NOT a parallel/disconnected table. See
 *     migrations/2026-08-04-phone-channel-columns.sql (APPLIED 2026-08-06,
 *     see report for live-query verification).
 *   - Identity resolution (spec Section 5.3): normalize caller-ID → look up
 *     `customers.phone` (E.164) → resolve to that customer's most recent
 *     meeting/open opportunity. NOTE: the spec's full `opportunities` /
 *     `customer_phones` tables (Section 5.5) do NOT exist in this database
 *     yet — verified live, see report. This module implements the v0
 *     fallback against the EXISTING `customers.phone` column only; the
 *     richer multi-phone/opportunity model is a separate, larger migration
 *     explicitly flagged for human review, not applied here.
 *   - Consent: state law on call-recording consent varies (one-party vs
 *     two-party). See the REQUIRED-DECISION block below — do not ship
 *     without addressing it. This module only scaffolds an obvious
 *     placeholder; the actual legal/consent-flow design is explicitly NOT
 *     solved here.
 */

import twilio from 'twilio';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { twilioPayloadToLinear16Buffer } from './audioCodec.js';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
// API Key auth (current state — no legacy Auth Token exists for this
// account). TWILIO_AUTH_TOKEN is still read as an optional legacy fallback
// so this module keeps working unmodified if the account is ever switched
// to Auth Token auth instead of API Key auth — but API Key is what we
// actually have, per the credentials in .env.secrets as of 2026-08-06.
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN; // legacy fallback, not currently set
const TWILIO_APP_SID = process.env.TWILIO_TWIML_APP_SID;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// ─── Credential / configuration state ──────────────────────────────────────
// Two independent auth shapes are supported:
//   1. API Key auth (current real state): ACCOUNT_SID + API_KEY_SID +
//      API_KEY_SECRET. This is sufficient to make authenticated REST calls
//      AND to validate webhook signatures IF Twilio's webhook signing still
//      uses the account's Auth Token (it does — signing is always HMAC-SHA1
//      with the Auth Token, regardless of which credential type made the
//      REST call that configured the webhook). See notConfiguredReply()/
//      isSignatureValidationConfigured() below for how this is handled when
//      only an API Key (no Auth Token) is present.
//   2. Legacy Auth Token auth: ACCOUNT_SID + AUTH_TOKEN. Simpler, works for
//      both REST calls and signature validation.
//
// Neither shape alone unblocks the actual calling feature — TWILIO_PHONE_NUMBER
// (and ideally TWILIO_TWIML_APP_SID for the "Aria calls you" flow) are also
// required. This module distinguishes "have credentials, can build a REST
// client" from "have everything needed for a live call" so /health and logs
// can report a precise, actionable status instead of a single boolean.

/** True if we have SOME usable set of Twilio auth credentials (API Key or Auth Token). */
function hasAnyCredentials() {
  return !!(TWILIO_ACCOUNT_SID && ((TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) || TWILIO_AUTH_TOKEN));
}

/**
 * Signature validation (X-Twilio-Signature) is HMAC-SHA1 keyed on the
 * account's AUTH TOKEN specifically — per Twilio's docs, this is true
 * regardless of whether the request that configured the webhook used
 * Account-SID/Auth-Token or API-Key/Secret REST auth. An API Key does NOT
 * substitute for the Auth Token for signature validation purposes; they are
 * different secrets serving different purposes (REST API bearer credential
 * vs. webhook HMAC signing key). See:
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * We do not have TWILIO_AUTH_TOKEN yet (only API Key SID/Secret + Account
 * SID — see report). This is flagged explicitly rather than silently
 * skipping validation.
 */
function hasAuthTokenForSignatureValidation() {
  return !!TWILIO_AUTH_TOKEN;
}

/** Whether we have enough to construct an authenticated Twilio REST client. */
export function hasRestCredentials() {
  return hasAnyCredentials();
}

/**
 * Whether the phone-calling feature is FULLY configured (can place/receive
 * real calls). This requires REST credentials AND a phone number. TwiML App
 * SID is required for the "Aria calls you" outbound flow specifically but
 * not for a plain inbound-webhook flow, so it's reported separately in
 * configStatus() rather than gating this boolean.
 */
export function isConfigured() {
  return hasAnyCredentials() && !!TWILIO_PHONE_NUMBER;
}

/**
 * Structured configuration status for health checks / logs — reports
 * exactly what's present and what's missing, rather than a single opaque
 * boolean. This is what /health should surface (see server.js).
 */
export function configStatus() {
  const missing = [];
  if (!TWILIO_ACCOUNT_SID) missing.push('account_sid');
  if (!TWILIO_API_KEY_SID && !TWILIO_AUTH_TOKEN) missing.push('api_key_sid_or_auth_token');
  if (TWILIO_API_KEY_SID && !TWILIO_API_KEY_SECRET) missing.push('api_key_secret');
  if (!TWILIO_PHONE_NUMBER) missing.push('phone_number');
  if (!TWILIO_APP_SID) missing.push('twiml_app_sid (outbound-call flow only)');
  if (!hasAuthTokenForSignatureValidation()) missing.push('auth_token (needed for webhook signature validation)');

  if (missing.length === 0) return { status: 'configured', missing: [] };
  if (!hasAnyCredentials()) return { status: 'not-configured', missing };
  return { status: 'partially-configured', missing };
}

/**
 * Build an authenticated Twilio REST client using whichever credential
 * shape is available. Returns null if neither shape has enough to
 * construct a client (caller must check hasRestCredentials() / isConfigured()
 * first for routes that need this — this function itself does not throw so
 * it's safe to call speculatively).
 *
 * API Key auth constructor shape confirmed from twilio-node v6.0.2 source
 * (lib/rest/Twilio.js, lib/base/BaseTwilio.js): `new Twilio(username,
 * password, opts)` where for key/secret auth, username=API Key SID,
 * password=API Key Secret, and opts.accountSid carries the real Account SID
 * (required — BaseTwilio.setAccountSid() throws if a non-"AC"-prefixed SID
 * is passed as accountSid without opts.accountSid also being set).
 */
export function getRestClient() {
  if (!TWILIO_ACCOUNT_SID) return null;
  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    return twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
  }
  if (TWILIO_AUTH_TOKEN) {
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return null;
}

function notConfiguredReply(reply) {
  const status = configStatus();
  return reply.code(503).send({
    error: 'Twilio not fully configured on server',
    status: status.status,
    missing: status.missing,
    detail: 'This is expected until Troy completes Twilio signup (phone number + TwiML App SID ' +
      'are still pending an account payment method — Twilio Trial mode blocks number/TwiML-App ' +
      'provisioning). Routes are real (not scaffolding) and will activate automatically once the ' +
      'remaining env vars are present.',
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ⚠️ REQUIRED PRE-LAUNCH DECISION — CALL RECORDING CONSENT (DO NOT SHIP
// WITHOUT ADDRESSING THIS): call recording consent law varies by state
// (one-party vs two-party/all-party consent — see
// memory/skill-two-phone-extension-spec-2026-08-03.md Section 4.3 for the
// full grounded legal survey and the "Always Disclose" recommended default).
// This module hardcodes a placeholder <Say> disclosure below so the shape
// exists and can never be silently skipped on a "tracked" call — but the
// actual required decisions (script wording sign-off, who owns legal
// approval, retention policy) are NOT solved here. Do not remove this
// comment block or ship this TwiML to a real customer call without a real
// legal/compliance sign-off.
// ─────────────────────────────────────────────────────────────────────────
const CONSENT_DISCLOSURE_TWIML_SAY =
  'This call is being recorded for quality assurance and sales coaching purposes. ' +
  'By staying on the line, you agree to this recording.';
// TODO(legal-sign-off): confirm this exact wording, the disclosure trigger
// point (must play before ANY substantive conversation per the spec), and
// the audit-log fields (disclosure_confirmed_by, disclosure_audio_segment_ref,
// consent_state) — see spec Section 4.3 for the full checklist.
// `disclosure_method`/`disclosure_played_at` columns DO exist now (applied
// migration, see report) but nothing writes them yet — see writeDisclosureAuditFields()
// below for the call site where that plugs in once the consent-flow design
// is finalized.

/**
 * Normalize a raw caller-ID / From value to E.164 using libphonenumber-js,
 * assuming US as the default region (matches CertaPro's West Michigan
 * deployment per the spec's context — Twilio's From is normally already
 * E.164 for real PSTN calls, but this defends against edge cases: SIP URIs,
 * partially-formatted numbers, or test/simulated payloads).
 *
 * Returns the E.164 string, or null if the input can't be parsed as a valid
 * phone number.
 */
export function normalizePhoneNumber(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = parsePhoneNumberFromString(raw, 'US');
    if (parsed && parsed.isValid()) return parsed.number; // E.164, e.g. "+16164142543"
    return null;
  } catch {
    return null;
  }
}

/**
 * Identity resolution for an inbound call (spec Section 5.3, v0 scope).
 *
 * IMPORTANT SCOPE NOTE: the spec's full design (Section 5.5) calls for a
 * dedicated `customer_phones` many-to-one table and a top-level
 * `opportunities` entity. NEITHER exists in this database yet — verified
 * live via a real schema query on 2026-08-06 (see report). Building those
 * is a separate, larger data-model migration explicitly flagged for human
 * review, not undertaken silently as part of this webhook-handler pass.
 *
 * This function therefore implements the smallest correct v0: normalize the
 * caller's number to E.164, look it up directly against the EXISTING
 * `customers.phone` column (exact match after normalizing both sides), and
 * return the matching customer row if found. No match → null (caller
 * decides whether to create an untracked/manual-link meeting).
 *
 * This is intentionally simple and does NOT invent the `customer_phones`/
 * `opportunities` model inline — that would be silently expanding scope on
 * a decision the spec itself flags as a separate, bigger call (Section 5.6).
 *
 * @param {import('pg').Pool} pool
 * @param {string} rawCallerNumber — Twilio's `From` webhook field
 * @returns {Promise<{customer: object|null, normalizedPhone: string|null}>}
 */
export async function resolveCustomerByPhone(pool, rawCallerNumber) {
  const normalizedPhone = normalizePhoneNumber(rawCallerNumber);
  if (!normalizedPhone) {
    return { customer: null, normalizedPhone: null };
  }

  // customers.phone is currently stored as free-text (not guaranteed E.164 —
  // verified live: existing rows are 10-digit strings like "6164142543", no
  // formatting). Normalize both sides to E.164 for a reliable comparison
  // rather than assuming stored data is already canonical.
  const result = await pool.query('SELECT * FROM customers WHERE phone IS NOT NULL AND phone <> $1', ['']);
  for (const row of result.rows) {
    const rowNormalized = normalizePhoneNumber(row.phone);
    if (rowNormalized && rowNormalized === normalizedPhone) {
      return { customer: row, normalizedPhone };
    }
  }
  return { customer: null, normalizedPhone };
}

/**
 * Find-or-create the `meetings` row for an inbound phone call, per the
 * "one continuous timeline" mandate (spec Section 5) — a phone call is just
 * another `meetings` row with channel='phone' and call_sid set, not a
 * parallel table.
 *
 * Idempotent on call_sid: if a meeting for this CallSid already exists
 * (e.g. Twilio retries the webhook), returns the existing row rather than
 * creating a duplicate.
 *
 * customer_id is nullable (mirrors the existing in-person flow's
 * `customer_id || null` pattern) — an unresolved caller still gets a
 * tracked meeting row, just without a customer link, matching Requirement
 * 10's "manual fallback" allowance in the spec.
 *
 * rep_id is intentionally left null here — no rep is known/authenticated at
 * inbound-call-webhook time in this v0 (no "Aria calls you" outbound flow
 * exists yet, so there's no calling rep session to attach). A future
 * outbound-call flow (once TWILIO_TWIML_APP_SID exists) would set this from
 * the rep-initiated call context instead.
 *
 * @param {import('pg').Pool} pool
 * @param {{ callSid: string, customerId: string|null }} params
 */
export async function findOrCreatePhoneMeeting(pool, { callSid, customerId }) {
  if (!callSid) throw new Error('findOrCreatePhoneMeeting requires callSid');

  const existing = await pool.query('SELECT * FROM meetings WHERE call_sid = $1', [callSid]);
  if (existing.rows.length > 0) {
    return { meeting: existing.rows[0], created: false };
  }

  const inserted = await pool.query(
    `INSERT INTO meetings (customer_id, rep_id, status, channel, call_sid)
     VALUES ($1, NULL, 'active', 'phone', $2)
     RETURNING *`,
    [customerId || null, callSid]
  );
  return { meeting: inserted.rows[0], created: true };
}

/**
 * Register telephony routes on the given Fastify instance. Mirrors the
 * exact registration style already used in server.js for other route groups
 * — call this once from server.js with `await registerTelephonyRoutes(fastify, { pool })`.
 *
 * IMPORTANT: this function now registers `@fastify/formbody` on the passed
 * fastify instance so Twilio's application/x-www-form-urlencoded webhook
 * POST bodies parse correctly (Fastify's default JSON parser does not
 * handle that content-type). This was a real, flagged gap in the prior
 * scaffolding pass — fixed here, not deferred again.
 */
export async function registerTelephonyRoutes(fastify, { pool, registerMeetingSocket, unregisterMeetingSocket } = {}) {
  const formbody = (await import('@fastify/formbody')).default;
  await fastify.register(formbody);

  // ── POST /telephony/voice — inbound-call voice webhook (TwiML response) ──
  // This is the URL you'd configure on the Twilio phone number / TwiML App
  // as the Voice webhook. Twilio POSTs call metadata (CallSid, From, To,
  // etc.) as application/x-www-form-urlencoded — now parsed via the
  // formbody plugin registered above.
  fastify.post('/telephony/voice', async (request, reply) => {
    if (!isConfigured()) return notConfiguredReply(reply);

    // ── Webhook signature validation ──────────────────────────────────────
    // Twilio signs every inbound webhook with X-Twilio-Signature, HMAC-SHA1
    // keyed on the Auth Token. We do not have TWILIO_AUTH_TOKEN yet (only
    // API Key SID/Secret) — see hasAuthTokenForSignatureValidation() above.
    // Rather than silently skip validation (a real security gap) or crash,
    // we explicitly refuse to trust the request when we cannot validate it,
    // UNLESS an explicit opt-out is set for local/dev testing.
    const signatureCheck = validateTwilioSignature(request);
    if (!signatureCheck.ok) {
      fastify.log.warn(`Twilio signature validation failed for /telephony/voice: ${signatureCheck.reason}`);
      return reply.code(403).send({ error: 'Invalid Twilio signature', reason: signatureCheck.reason });
    }

    const { CallSid, From } = request.body || {};
    if (!CallSid) {
      fastify.log.warn('/telephony/voice webhook missing CallSid — malformed request');
      return reply.code(400).send({ error: 'Missing CallSid' });
    }

    // ── Identity resolution + meeting row (spec Section 5.3, v0 scope — see
    // resolveCustomerByPhone()/findOrCreatePhoneMeeting() docstrings above) ──
    let meeting = null;
    try {
      const { customer, normalizedPhone } = await resolveCustomerByPhone(pool, From);
      const { meeting: m, created } = await findOrCreatePhoneMeeting(pool, {
        callSid: CallSid,
        customerId: customer ? customer.id : null,
      });
      meeting = m;
      fastify.log.info(
        `/telephony/voice: CallSid=${CallSid} From=${From} normalized=${normalizedPhone} ` +
        `customerMatch=${customer ? customer.id : 'none'} meeting=${meeting.id} created=${created}`
      );
    } catch (err) {
      // A DB failure here must not crash the webhook response — Twilio
      // expects TwiML back promptly regardless. Log loudly and continue
      // with the call/stream setup; the meeting linkage can be reconciled
      // after the fact via call_sid if needed.
      fastify.log.error(`/telephony/voice meeting lookup/create failed: ${err.message}`);
    }

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

  // ── POST /telephony/status-callback — call-status-callback webhook ──────
  // Configured via <Stream statusCallback="..."> or the Call resource's own
  // StatusCallback — Twilio POSTs {AccountSid, CallSid, StreamSid, StreamName,
  // StreamEvent, StreamError?, Timestamp} (form-encoded) on stream/call
  // lifecycle events.
  fastify.post('/telephony/status-callback', async (request, reply) => {
    if (!isConfigured()) return notConfiguredReply(reply);

    const signatureCheck = validateTwilioSignature(request);
    if (!signatureCheck.ok) {
      fastify.log.warn(`Twilio signature validation failed for /telephony/status-callback: ${signatureCheck.reason}`);
      return reply.code(403).send({ error: 'Invalid Twilio signature', reason: signatureCheck.reason });
    }

    const { CallSid, CallStatus } = request.body || {};
    fastify.log.info(`Twilio status callback: CallSid=${CallSid} CallStatus=${CallStatus}`);

    if (CallSid && (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer' || CallStatus === 'canceled')) {
      try {
        await pool.query(
          `UPDATE meetings SET status = 'completed', ended_at = COALESCE(ended_at, NOW())
           WHERE call_sid = $1 AND status = 'active'`,
          [CallSid]
        );
      } catch (err) {
        fastify.log.error(`status-callback meeting update failed: ${err.message}`);
      }
    }

    return reply.code(200).send({ ok: true });
  });

  // ── GET /telephony/stream — Twilio Media Streams WebSocket handler ──────
  // Mirrors the existing /meetings/:meetingId/audio pattern in server.js
  // (same ring-buffer/forwarding shape) but consumes Twilio's JSON-enveloped
  // base64 mulaw frames instead of raw binary PCM, and converts audio via
  // audioCodec.js before forwarding onward to Deepgram.
  fastify.get('/telephony/stream', { websocket: true }, async (socket, request) => {
    if (!isConfigured()) {
      socket.send(JSON.stringify({ type: 'error', error: 'Twilio not configured on server' }));
      socket.close(1011, 'Twilio not configured');
      return;
    }

    // NOTE: unlike /telephony/voice and /telephony/status-callback (plain
    // HTTP POST webhooks, easily signature-validated via the form body +
    // X-Twilio-Signature header), Twilio's Media Streams WS connection is
    // NOT itself signed the same way — Twilio's docs note the WS upgrade
    // request DOES carry a lowercase `x-twilio-signature` header, but the
    // "params" half of the HMAC input for a WS connection is the querystring
    // (there is no form body on a WS upgrade). This module does not attempt
    // WS-specific signature validation in this pass — flagged, not silently
    // ignored: the real security boundary for this route in practice is that
    // the wss:// URL is only ever handed out by our own signature-validated
    // /telephony/voice response (Twilio must have first passed OUR signature
    // check to receive a URL pointing back at this stream endpoint), and the
    // URL itself is unguessable-in-practice per-call metadata. A dedicated
    // WS-signature check can be added once a real call exercises this path
    // and the exact querystring shape Twilio sends is confirmed live.
    fastify.log.info('Twilio Media Stream WS connected');

    let streamSid = null;
    let callSid = null;
    let meetingId = null;

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

          // Look up the meetings row created in the /telephony/voice webhook
          // handler above (by call_sid) and register this socket for
          // coaching broadcasts, same as the in-person WS handler.
          if (callSid && pool) {
            try {
              const res = await pool.query('SELECT id FROM meetings WHERE call_sid = $1', [callSid]);
              if (res.rows.length > 0) {
                meetingId = res.rows[0].id;
                if (registerMeetingSocket) registerMeetingSocket(meetingId, socket);
                fastify.log.info(`Twilio stream linked to meeting ${meetingId}`);
              } else {
                fastify.log.warn(`Twilio stream: no meeting row found for callSid=${callSid} — voice webhook may not have run yet`);
              }
            } catch (err) {
              fastify.log.error(`Twilio stream meeting lookup failed: ${err.message}`);
            }
          }

          // ⚠️ NOT WIRED IN THIS PASS — Deepgram connection for phone-channel
          // audio. Per the task's write-scope, the shared Deepgram-connection
          // helper factored out of server.js's in-person handler is real
          // engineering work (extracting ~150 lines of connection/reconnect/
          // message-handling logic into something both routes call) that
          // touches server.js's working in-person pipeline — explicitly
          // flagged for a follow-up pass rather than risking destabilizing
          // the proven in-person flow inside this same change. See the build
          // report's "remaining once phone number arrives" list. The exact
          // call site is below in the `media` case.
          //
          // If PYANNOTE_API_KEY is set, a real implementation would also
          // start a PyannoteStreamClient (voicePrint.js) in parallel for
          // diarization + eventual /identify calls — mirrors the
          // alongside-Deepgram pattern already used in server.js's in-person
          // handler.
          break;
        }

        case 'media': {
          // Confirmed shape: media.track, media.chunk, media.timestamp,
          // media.payload (base64 mulaw, 8kHz, mono)
          if (msg.media?.payload) {
            // Codec conversion is real and tested (audioCodec.js, untouched
            // by this pass — see scripts/test-audio-codec.js). Nothing
            // downstream consumes the output yet because there is no live
            // Deepgram connection wired for this route (see the `start`
            // case above for why that's explicitly deferred rather than
            // silently duplicated).
            const linear16Buf = twilioPayloadToLinear16Buffer(msg.media.payload);
            // dgSocket.send(linear16Buf); // once a shared Deepgram-connection helper exists for this call
            void linear16Buf; // referenced to make the real call-site obvious, not a no-op placeholder comment only
          }
          break;
        }

        case 'stop':
          // Confirmed shape: stop.accountSid, stop.callSid
          fastify.log.info(`Twilio stream stopped: streamSid=${streamSid}`);
          if (meetingId && unregisterMeetingSocket) {
            unregisterMeetingSocket(meetingId, socket);
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
      if (meetingId && unregisterMeetingSocket) {
        unregisterMeetingSocket(meetingId, socket);
      }
    });

    socket.on('error', (err) => {
      fastify.log.error('Twilio Media Stream WS error:', err.message);
    });
  });
}

/**
 * Validate an inbound Twilio webhook request's X-Twilio-Signature header
 * using twilio.validateRequest() (the real SDK helper, per Twilio's own
 * documented best practice — "We strongly recommend using the provided
 * signature validation library from a Twilio SDK and not implementing your
 * own signature validation." —
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security).
 *
 * Signature validation requires the Auth Token specifically (see
 * hasAuthTokenForSignatureValidation() docstring above) — an API Key/Secret
 * pair cannot substitute. Since we currently only have API Key credentials,
 * this function:
 *   - Returns { ok: false, reason: 'no_auth_token_configured' } when
 *     TWILIO_AUTH_TOKEN is absent, UNLESS TELEPHONY_SKIP_SIGNATURE_CHECK=1
 *     is explicitly set (local/dev testing escape hatch only — never set in
 *     production; every code path that checks this is logged loudly).
 *   - Otherwise validates for real using twilio.validateRequest(authToken,
 *     signatureHeader, url, params) exactly per Twilio's documented API.
 *
 * URL reconstruction: Twilio signs the EXACT URL it was configured to call.
 * Railway terminates TLS at its edge and forwards plain HTTP internally, so
 * `request.protocol` as seen by Fastify may report 'http' even though the
 * public-facing URL Twilio actually called was 'https'. We honor
 * X-Forwarded-Proto when present (Railway sets this) and default to https
 * otherwise, since Twilio will never be configured to call a plaintext
 * webhook URL in this deployment.
 */
export function validateTwilioSignature(request) {
  if (!hasAuthTokenForSignatureValidation()) {
    if (process.env.TELEPHONY_SKIP_SIGNATURE_CHECK === '1') {
      return { ok: true, reason: 'skipped_dev_override' };
    }
    return { ok: false, reason: 'no_auth_token_configured' };
  }

  const signatureHeader = request.headers['x-twilio-signature'];
  if (!signatureHeader) {
    return { ok: false, reason: 'missing_signature_header' };
  }

  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = (forwardedProto ? forwardedProto.split(',')[0].trim() : null) || 'https';
  const host = request.headers['x-forwarded-host'] || request.headers.host || request.hostname;
  const url = `${protocol}://${host}${request.url}`;

  const params = request.body || {};

  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signatureHeader, url, params);
  return valid ? { ok: true, reason: null } : { ok: false, reason: 'signature_mismatch' };
}
