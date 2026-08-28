/**
 * server.js — SorterPro Sales Helper API
 * Phase 1: Auth, meetings, customers
 * Phase 2: WebSocket audio → Deepgram live transcription, consent, summary
 * Phase 3: Real-time coaching engine (DISC, stage, checklist, nudges)
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID, randomInt } from 'crypto';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import WebSocket from 'ws';
import { extractVoiceFeatures, similarityScore } from './voiceFeatures.js';
import { createMeetingDoc } from './googleDocs.js';
// Aria Phone Channel / pyannoteAI scaffolding (2026-08-04) — both modules are
// safely no-op until their respective env vars (PYANNOTE_API_KEY,
// TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER) are set. See
// voicePrint.js / telephony.js module-level docs for full context.
import * as pyannote from './voicePrint.js';
import { registerTelephonyRoutes, isConfigured as isTwilioConfigured, configStatus as twilioConfigStatus, normalizePhoneNumber } from './telephony.js';
// ARIA Priority 1 roadmap (2026-08-05): BANT/closing-certainty, insider-
// language flagger, question-listening gaps. See coachingAnalysis.js.
import { analyzeBant, analyzeInsiderLanguage, analyzeQuestionGaps, generateRebuttal } from './coachingAnalysis.js';
// Item 5 (live rebuttal teleprompter) — STUB detection half. See
// objectionDetection.js module docstring for real-vs-stubbed breakdown.
import { detectObjection } from './objectionDetection.js';
// Live rebuttal TELEPROMPTER pass (2026-08-18, second pass) — matches the
// PROSPECT's finalized transcript segments against the Objections/Rebuttals
// library added in commit 053c81e (rep-curated text, not LLM output), with
// its own local keyword/substring matcher (no LLM call per segment) plus
// per-meeting cooldown/dismiss/concurrency noise control. Entirely separate
// from, and does not replace, the existing objectionDetection.js +
// coachingAnalysis.js's generateRebuttal() STUB pipeline just above — see
// this module's header and this task's report for why both now coexist.
import {
  loadObjectionMatcherIndex,
  evaluateLibraryMatch,
  markPromptFired,
  markPromptDismissed,
  clearMeetingPromptState,
} from './objectionLibraryMatcher.js';
// Name-likelihood classifier for mid-call self-introduction detection
// ("Hi, I'm John"). Replaces the old hand-picked STOPWORDS blocklist — see
// nameHeuristics.js header for why (dictionary signal, not capitalization).
import { isLikelyName, toDisplayName } from './nameHeuristics.js';
import {
  createInPersonIntroductionLabeler,
  isEligibleInPersonMeeting,
  persistIntroductionResolution,
} from './inPersonIntroductionLabels.js';
import { createReconnectTracker } from './dgReconnectPolicy.js';
import { createReadinessTracker } from './readinessTracker.js';
import { registerUploadedRecordingRoutes, UPLOADED_RECORDING_CHANNEL } from './uploadedRecording.js';
import { normalizeMeetingTitle, requireSingleMeetingUpdate } from './meetingTitle.js';
import { AiGenerationError, createAnthropicPrimaryTextGenerator } from './aiProvider.js';
import { registerScheduledMeetingRoutes } from './scheduledMeetings.js';
import {
  loadEnrolledVoicePrint,
  voiceFingerprintIdentificationPolicy,
} from './voiceFingerprintIdentification.js';

const { Pool } = pg;

// ─── Config ───────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Support both OPENROUTER_API_KEY (canonical) and OPENROUTER_KEY (legacy .env.secrets)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const PORT = parseInt(process.env.PORT || '3000', 10);
const voiceFingerprintPolicy = voiceFingerprintIdentificationPolicy(
  process.env.ENABLE_VOICE_FINGERPRINT_IDENTIFICATION
);

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.warn('WARN: DEEPGRAM_API_KEY not set — WebSocket audio endpoint will reject connections.');
}

if (!pyannote.isConfigured()) {
  console.warn('WARN: PYANNOTE_API_KEY not set — pyannoteAI voiceprint identification is scaffolded but inactive.');
}

{
  const twStatus = twilioConfigStatus();
  if (twStatus.status !== 'configured') {
    console.warn(`WARN: Twilio ${twStatus.status} — missing: ${twStatus.missing.join(', ')}. Aria Phone Channel routes will return 503 until phone_number/twiml_app_sid arrive.`);
  }
}

if (!OPENROUTER_API_KEY) {
  console.warn('WARN: OPENROUTER_API_KEY (or OPENROUTER_KEY) not set — coaching and Anthropic fallback will be unavailable.');
}

if (!voiceFingerprintPolicy.automaticIdentification) {
  console.warn('Automatic voice-fingerprint identification is disabled by feature flag (ENABLE_VOICE_FINGERPRINT_IDENTIFICATION=false).');
}

// ─── Knowledge base (loaded at startup) ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

let kbDiscFramework = '';
let kbFirstGoAround = '';
let kb10Plus1Process = '';

async function loadKnowledgeBase() {
  const kbDir = join(__dirname, 'knowledge');
  try {
    kbDiscFramework = await readFile(join(kbDir, 'disc-framework.md'), 'utf-8');
    console.log('✓ Loaded disc-framework.md');
  } catch (e) {
    console.warn('WARN: Could not load disc-framework.md:', e.message);
  }
  try {
    kbFirstGoAround = await readFile(join(kbDir, 'certapro-1st-go-around.md'), 'utf-8');
    console.log('✓ Loaded certapro-1st-go-around.md');
  } catch (e) {
    console.warn('WARN: Could not load certapro-1st-go-around.md:', e.message);
  }
  try {
    kb10Plus1Process = await readFile(join(kbDir, 'certapro-10plus1-sales-process.md'), 'utf-8');
    console.log('✓ Loaded certapro-10plus1-sales-process.md');
  } catch (e) {
    console.warn('WARN: Could not load certapro-10plus1-sales-process.md:', e.message);
  }
}

// ─── Active WebSocket connections (meetingId → Set<WebSocket>) ───────────────
// Used to push coaching updates to clients without polling

const activeMeetingSockets = new Map();

function registerMeetingSocket(meetingId, socket) {
  if (!activeMeetingSockets.has(meetingId)) {
    activeMeetingSockets.set(meetingId, new Set());
  }
  activeMeetingSockets.get(meetingId).add(socket);
}

function unregisterMeetingSocket(meetingId, socket) {
  const sockets = activeMeetingSockets.get(meetingId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) activeMeetingSockets.delete(meetingId);
  }
}

// ─── Live speaker-lock controllers (2026-08-10, intro-window fix) ────────────
// The mid-call name-introduction detector no longer silently auto-locks a
// speaker to a guessed name. After a 15s collection window it emits a
// `speaker_lock_suggestion` and waits for a human to confirm/reject via
// POST /api/meetings/:id/speaker-lock. That REST route runs OUTSIDE the audio
// WS handler closure where the per-connection `speakerLocks` map actually
// lives, so it can't mutate the live lock state directly. This registry is
// the bridge: the audio WS handler registers a small controller
// ({ confirm, reject }) for its meetingId while connected; the REST route
// looks it up and calls into the closure. Keyed by meetingId; a meeting has
// at most one live audio connection at a time (enforced by the
// owner_session_id check on the audio route), so a single controller per
// meeting is correct. Unregistered on socket close.
const activeMeetingSpeakerControllers = new Map();

function registerSpeakerController(meetingId, controller) {
  activeMeetingSpeakerControllers.set(meetingId, controller);
}

function unregisterSpeakerController(meetingId, controller) {
  // Only delete if it's still OUR controller (guard against a reconnect having
  // already replaced it).
  if (activeMeetingSpeakerControllers.get(meetingId) === controller) {
    activeMeetingSpeakerControllers.delete(meetingId);
  }
}

// ─── Live meeting sync (mobile → web), 2026-08-05 ───────────────────────────
// v1, mobile-origin only (per Troy's explicit scope — web-started meetings
// syncing to mobile is NOT built here, see report). Read-only "observer"
// sockets for OTHER logged-in sessions of the SAME user_id as the meeting's
// owner. These do NOT stream audio and do NOT run a second Deepgram/
// coaching pipeline — they are pure fan-out targets for the exact same
// messages already produced by the owner's live audio-streaming connection
// below (final/interim transcript, speaker_lock/unlock/merge, coaching,
// suggested_rebuttal), plus a `meeting_ended` push when the owning session
// finalizes the meeting (see PATCH /api/meetings/:id and
// finalizeMeetingIfAbandoned()). Kept as a SEPARATE Map (not merged into
// activeMeetingSockets) so the existing owner-socket bookkeeping — which
// several other pieces of this file key real behavior off of (abandoned-
// meeting grace-period finalization checks `sockets.size > 0` on
// activeMeetingSockets specifically to mean "an audio-streaming client is
// still connected") — is completely undisturbed by this addition.
const activeMeetingObservers = new Map();

function registerObserverSocket(meetingId, socket) {
  if (!activeMeetingObservers.has(meetingId)) {
    activeMeetingObservers.set(meetingId, new Set());
  }
  activeMeetingObservers.get(meetingId).add(socket);
}

function unregisterObserverSocket(meetingId, socket) {
  const sockets = activeMeetingObservers.get(meetingId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) activeMeetingObservers.delete(meetingId);
  }
}

function broadcastToObservers(meetingId, payload) {
  const sockets = activeMeetingObservers.get(meetingId);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

// ── Per-user "presence" channel (userId → Set<WebSocket>) ──────────────────
// Separate from both activeMeetingSockets (owner audio streaming) and
// activeMeetingObservers (per-meeting read-only fan-out). This one is keyed
// by user_id, not meeting_id, because a session that ISN'T currently
// watching any specific meeting still needs a way to find out "a meeting
// just started for my account" in near-real-time, without polling — e.g.
// the web app sitting on the Home/meeting-list screen with no meeting page
// open yet. Any authenticated session (web tab or, in principle, a future
// mobile client) can open GET /api/sync to join this channel; see that
// route below for the connect-time "is there already an active mobile
// meeting for me right now" catch-up check.
const activeUserSyncSockets = new Map();

function registerUserSyncSocket(userId, socket) {
  if (!activeUserSyncSockets.has(userId)) {
    activeUserSyncSockets.set(userId, new Set());
  }
  activeUserSyncSockets.get(userId).add(socket);
}

function unregisterUserSyncSocket(userId, socket) {
  const sockets = activeUserSyncSockets.get(userId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) activeUserSyncSockets.delete(userId);
  }
}

function notifyUserSyncMeetingStarted(userId, meeting) {
  const sockets = activeUserSyncSockets.get(userId);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify({
    type: 'meeting_started',
    meeting: {
      id: meeting.id,
      customer_id: meeting.customer_id,
      started_at: meeting.started_at,
      title: meeting.title || null,
    },
  });
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

function notifyUserSyncMeetingEnded(userId, meetingId) {
  const sockets = activeUserSyncSockets.get(userId);
  if (!sockets || sockets.size === 0) return;
  const msg = JSON.stringify({ type: 'meeting_ended', meetingId });
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

// Broadcasts to the owner-registered socket(s) for a meeting (existing
// behavior, unchanged) AND to any read-only observer sockets synced to the
// same meeting (new, 2026-08-05) — e.g. the periodic `coaching` push below
// already used this function before observers existed; it now reaches both
// audiences with no call-site changes required for that message type.
function broadcastToMeeting(meetingId, payload) {
  const sockets = activeMeetingSockets.get(meetingId);
  if (sockets) {
    const msg = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(msg);
      }
    }
  }
  broadcastToObservers(meetingId, payload);
}

// ── Live meeting sync full-page rebuild, 2026-08-05 ─────────────────────────
// Shapes a raw `meetings` row for client consumption, computing
// `is_owner_session` (does THIS request's session cookie match the row's
// owner_session_id) and never leaking the raw owner_session_id value itself
// to the client. Used by every GET/PATCH meeting-detail route below so the
// web app's MeetingPage can render the SAME component for "my own web
// meeting" and "observing a mobile meeting" while still knowing, per
// request, whether THIS session is allowed to drive the mic/End Meeting —
// replaces the popup-only MeetingSyncDialog.tsx approach (removed) which
// never needed this because it had no owner-gated controls at all.
// Permissive default (`true`) when owner_session_id is NULL, matching the
// existing permissive-when-NULL convention used by the PATCH ownership
// check and the audio-WS ownership check elsewhere in this file — a
// pre-migration meeting (or any meeting created before this column
// existed) is never treated as "someone else's" meeting.
function shapeMeetingForClient(meetingRow, requestSessionId) {
  if (!meetingRow) return meetingRow;
  // Keep introduction evidence server-side for audit/debug. The UI only
  // needs resolved labels, not internal provenance identifiers.
  const { owner_session_id, speaker_label_evidence: _speakerLabelEvidence, ...rest } = meetingRow;
  return {
    ...rest,
    is_owner_session: !owner_session_id || owner_session_id === requestSessionId,
  };
}

// ─── Root-cause fix (2026-08-05): stuck-`active`-meeting bug ────────────────
// Diagnosed 2026-08-04 (see memory/aria-web-runaway-meetings-2026-08-04.md,
// "ROOT CAUSE of remaining open indefinitely"): the audio WS's `close`
// handler tore down the Deepgram connection but never touched the
// `meetings` row's status. A meeting only ever left `'active'` via the
// EXPLICIT client-initiated `PATCH /api/meetings/:id` (the "End Meeting"
// button's call, and now also the mobile leave-app-guard's call — see
// app/mobile/src/app/meeting.tsx). Any client that never got to send that
// PATCH (crash, backgrounded/killed app, network drop, force-quit, or a
// server restart while a client was connected) left its meeting row
// permanently stuck `'active'`.
//
// Fix: when a meeting's audio WS closes, schedule a check after a grace
// period; if no client has reconnected for that meetingId by then AND the
// row is still `'active'`, transition it to a terminal state server-side —
// the exact same effect as the client PATCH, just server-initiated instead
// of relying on a client that may never call it.
//
// STATUS NAME CHOSEN: `'interrupted'`, NOT `'completed'`.
// Reasoning (flagged for Gabe/Troy sign-off — this is a judgment call, not
// settled): `'completed'` in this schema has always meant "the rep tapped
// End Meeting" — a clean, intentional end where a summary is expected to
// make sense. Silently relabeling a crashed/dropped/backgrounded meeting as
// `'completed'` would make it indistinguishable from a normal meeting in
// every list/report, hiding exactly the failure mode this fix exists to
// stop happening invisibly. `'interrupted'` preserves that signal (reps/
// admins can tell "this one didn't end normally" at a glance, e.g. to know
// a transcript may be truncated) while still being a genuine terminal state
// that satisfies the actual requirement ("stops looking active forever").
// This requires widening the `meetings_status_check` CHECK constraint — see
// the new (written but NOT applied to prod) migration file
// `migrations/2026-08-05-meeting-interrupted-status.sql`. Until that
// migration is applied, the UPDATE below would violate the CHECK
// constraint and fail (caught + logged, not thrown) — see that migration
// file for why it hasn't been run yet.
//
// GRACE PERIOD, NOT AN IMMEDIATE FLIP: chosen instead of finalizing the
// instant the socket closes because the web PWA (app/web/src/pages/
// MeetingPage.tsx) already has its OWN client-side auto-reconnect with
// exponential backoff (capped at 10s) for exactly this kind of transient
// disconnect (brief network blip, dev server reload, etc.) — finalizing
// immediately would end a meeting the user never actually left, right as
// their own client is about to silently reconnect and keep streaming to a
// meetingId the server just called done. A grace period comfortably longer
// than that reconnect cap lets a legitimately-reconnecting client "cancel"
// this check simply by being registered again (`activeMeetingSockets` has
// a live socket for that meetingId) by the time it fires. The mobile app's
// leave-app-guard (meeting.tsx) does not currently auto-reconnect at all,
// so for mobile this grace period only ever delays (not prevents) the
// eventual finalize — mobile's own best-effort client-side PATCH almost
// always beats it anyway.
const ABANDONED_MEETING_GRACE_MS = 20_000;

async function finalizeMeetingIfAbandoned(meetingId) {
  try {
    const sockets = activeMeetingSockets.get(meetingId);
    if (sockets && sockets.size > 0) {
      // A client (the same one reconnecting, or another) is registered for
      // this meeting again — treat the earlier close as a transient blip,
      // not an abandonment. Leave the row alone.
      return;
    }
    const result = await pool.query(
      `UPDATE meetings
       SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW())
       WHERE id = $1 AND status = 'active'
       RETURNING id, rep_id, origin_client, title`,
      [meetingId]
    );
    if (result.rows.length > 0) {
      fastify.log.warn(
        `Meeting ${meetingId} auto-finalized as 'interrupted' — WS closed and no client reconnected within ${ABANDONED_MEETING_GRACE_MS}ms.`
      );
      // Live meeting sync (2026-08-05): the owning mobile device losing its
      // connection mid-meeting (crash, network drop, killed app) with no
      // reconnect is exactly the scenario this auto-finalize exists for —
      // and it's also a case the synced web dialog needs to know about, not
      // just sit "live" forever waiting for a meeting_ended push that a
      // graceful End Meeting tap would have sent but this path otherwise
      // wouldn't. Reuses the same notification calls the PATCH route uses.
      broadcastToObservers(meetingId, { type: 'meeting_ended', meetingId, status: 'interrupted' });
      notifyUserSyncMeetingEnded(result.rows[0].rep_id, meetingId);
      // Auto-title (origin-agnostic as of the 2026-08-05 follow-up pass —
      // see generateAutoTitleForMeeting() doc comment below for full scope/
      // reasoning/history). A crashed/dropped meeting (mobile OR web) that
      // never hit the client's own "End Meeting" PATCH still deserves an
      // auto-title if enough transcript exists — this is the OTHER terminal
      // path (server-initiated instead of client-initiated) that can
      // finalize a meeting, so it needs the same hook as the PATCH route
      // below. No origin_client gate here anymore (previously mobile-only);
      // fires for any origin. Fire-and-forget: never blocks/throws into the
      // WS close handler that calls this function.
      if (!result.rows[0].title) {
        generateAutoTitleForMeeting(meetingId).catch((err) => {
          fastify.log.error(`generateAutoTitleForMeeting error (abandoned-meeting path) for ${meetingId}: ${err.message}`);
        });
      }
    }
  } catch (err) {
    // Non-fatal: most likely cause right now is the CHECK constraint not
    // yet allowing 'interrupted' (migration not applied — see file header
    // note above). Logged, not thrown, so a WS close never crashes the
    // server over this.
    fastify.log.error(`Failed to auto-finalize abandoned meeting ${meetingId}: ${err.message}`);
  }
}

// Direct Anthropic remains primary for summary/title generation. OpenRouter
// is a runtime fallback, not merely a startup-time choice based on key presence.
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const anthropicPrimaryText = createAnthropicPrimaryTextGenerator({
  anthropicApiKey: ANTHROPIC_API_KEY,
  openRouterApiKey: OPENROUTER_API_KEY,
  anthropicClient: anthropic,
});

function formatAiFailure(error) {
  if (!(error instanceof AiGenerationError)) return 'provider error';
  if (!error.attempts.length) return 'no provider configured';
  return error.attempts
    .map(({ provider, status }) => `${provider}${status ? ` HTTP ${status}` : ''}`)
    .join(', ');
}

// ─── Auto-title (origin-agnostic: mobile + web), 2026-08-05 ────────────────
// Backlog item was "auto-generate a meeting title from the 2+ identified
// speakers" (ties into diarization/voiceprint work) — explicitly NOT what
// this pass builds. Per Gabe's clarification, v1 is a plain CONTENT summary
// title ("what was this call about", 3-9 words), generated from the
// transcript text alone, no speaker-identity logic at all. That fuller
// speaker-based titling is a separate future item.
//
// SCOPE (updated 2026-08-05, follow-up pass): originally shipped mobile-
// only (`origin_client === 'mobile'`) earlier today. Per Gabe's explicit
// follow-up decision, that restriction is now REMOVED — this fires for
// BOTH web-started and mobile-started meetings, using the exact same
// generalized logic/call sites (no duplicated web-specific code path).
// Every call site below (finalizeMeetingIfAbandoned() above and the PATCH
// /api/meetings/:id route below) now calls this function regardless of
// `origin_client`; this function itself never checked origin_client
// directly (callers were always the enforcement point), so no change was
// needed inside the function body for this part — only the callers' gates
// were relaxed.
//
// TRIGGER: meeting finalization (status becomes a TERMINAL_MEETING_STATUS),
// mirroring the timing of the existing manual POST /:id/summary flow —
// full transcript is available at that point, same rationale. Unlike
// summary generation (which stays a manual rep-tap for both platforms,
// unchanged by this pass), auto-title fires automatically server-side
// (no button, no client call) since it's cheap/low-stakes and "mostly for
// testing purposes" per the ask — explicitly a judgment call, flagged in
// the report for Gabe/Troy sign-off alongside the other open questions
// there (e.g. should manual edits be protected from being overwritten by
// a later re-run of this).
//
// STORAGE: reuses the EXISTING `title` column on `meetings` (already used
// by the web PWA's manual "Add a title…" field — see MeetingPage.tsx).
// Only fires when `title` is currently NULL/empty (see the `!title` guard
// at both call sites) so it never silently clobbers a title a rep already
// set by hand. As of this follow-up pass, a companion `auto_titled`
// boolean column has been added (migration:
// server/migrations/2026-08-05-meeting-auto-titled-flag.sql, WRITTEN BUT
// NOT APPLIED to prod, per the standing convention in this repo) — this
// function's UPDATE now also sets `auto_titled = true` whenever it
// successfully writes a generated title, so the system/future UI can tell
// an AI-generated title apart from a human-typed one. The PATCH route
// below sets `auto_titled = false` whenever a caller supplies an explicit
// `title` in the request body (a manual edit/override), since at that
// point the stored title is no longer purely AI-generated. The race
// described previously (a manual title landing between finalize-time-
// trigger and this async call resolving) is still closed by the same
// `WHERE title IS NULL OR title = ''` guard on this function's own UPDATE.
//
// TITLE LENGTH: the system prompt below still asks the model to aim for
// 3-9 words, but per Gabe's explicit testing-phase decision there is NO
// programmatic validation/rejection/truncation/regeneration on the actual
// returned length — whatever the model returns (after the wrapping-quote/
// trailing-punctuation cleanup below, which is formatting cleanup, not
// length enforcement) is stored as-is. This was already true before this
// follow-up pass (no retry/regeneration logic existed previously either)
// and remains unchanged now — confirmed, no code change needed for this
// item; noted here explicitly so it doesn't get re-added by accident
// later without a deliberate decision to do so.
//
// MODEL: claude-haiku-4-5 via the SAME OpenRouter-or-Anthropic-direct path
// already used by runCoachingAnalysis()/the summary endpoint above — no
// new provider, no new API key requirement.
async function generateAutoTitleForMeeting(meetingId) {
  // ── Feature flag (2026-08-05 pre-deploy gating pass) ──────────────────────
  // The `auto_titled` DB column already exists in prod (migration applied
  // directly via psql, separate from this deploy — see
  // server/migrations/2026-08-05-meeting-auto-titled-flag.sql), but the
  // GENERATION call below (real OpenRouter/Anthropic API spend on every
  // meeting finalize, both call sites: finalizeMeetingIfAbandoned() and the
  // PATCH /api/meetings/:id finalize path) has NOT been cost-approved by
  // Troy yet. Hard off-switch: this function returns immediately, before any
  // DB read or model call, unless ENABLE_AUTO_TITLE_GENERATION=true is set.
  // Intentionally NOT set on Railway as part of this deploy — leave unset so
  // the feature ships completely inert. Set it on the aria-backend Railway
  // service once Troy approves the recurring cost.
  if (process.env.ENABLE_AUTO_TITLE_GENERATION !== 'true') {
    fastify.log.info(`auto-title: generation disabled (ENABLE_AUTO_TITLE_GENERATION not 'true'), skipping for ${meetingId}`);
    return null;
  }

  if (!ANTHROPIC_API_KEY && !OPENROUTER_API_KEY) return null;

  let segments;
  try {
    const segResult = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
      [meetingId]
    );
    segments = segResult.rows;
  } catch (err) {
    fastify.log.error(`auto-title: DB error fetching segments for ${meetingId}: ${err.message}`);
    return null;
  }

  // Too little transcript to summarize meaningfully — same floor as the
  // coaching analysis's `segments.length < 3` bail-out, for the same reason
  // (a title generated from 1-2 lines is noise, not signal).
  if (segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

  const TITLE_SYSTEM = `You write short, plain-English meeting titles for sales-call transcripts. Read the transcript and output ONE title only — no quotes, no punctuation at the end, no preamble, no explanation. 3 to 9 words. It should describe what the call was actually about (e.g. "Kitchen cabinet refinish estimate walkthrough", "Follow-up on flooring quote pricing"). Do not mention speaker names or "Speaker 1/2" labels.`;
  const TITLE_USER = `Transcript:\n\n${transcriptText.slice(0, 6000)}\n\nOutput only the title.`;

  let titleText = null;
  try {
    const generated = await anthropicPrimaryText.generate({
      model: 'claude-haiku-4-5',
      maxTokens: 40,
      system: TITLE_SYSTEM,
      messages: [{ role: 'user', content: TITLE_USER }],
    });
    titleText = generated.text;
  } catch (err) {
    fastify.log.error(`auto-title: generation failed for ${meetingId} (${formatAiFailure(err)})`);
    return null;
  }

  if (!titleText) return null;

  // Clean up: strip wrapping quotes/whitespace/trailing period Claude
  // sometimes adds despite the system prompt telling it not to.
  titleText = titleText.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.\s]+$/, '').trim();
  if (!titleText) return null;

  try {
    // Guard again inside the write itself: only overwrite if title is still
    // NULL/empty at write time (closes most of the manual-title race window
    // described above — does not need its own migration/flag, just a WHERE
    // clause on the existing column).
    const result = await pool.query(
      `UPDATE meetings SET title = $1, auto_titled = true WHERE id = $2 AND (title IS NULL OR title = '') RETURNING id, title, auto_titled`,
      [titleText, meetingId]
    );
    if (result.rows.length === 0) {
      fastify.log.info(`auto-title: skipped write for ${meetingId} — title already set (manual title race, or already auto-titled).`);
      return null;
    }
  } catch (err) {
    fastify.log.error(`auto-title: failed to save title for ${meetingId}: ${err.message}`);
    return null;
  }

  return titleText;
}

// ─── DB Pool ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Postgres-backed session store (survives restarts) ──────────────────────

async function ensureSessionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  // speaker_labels column on meetings (added 2026-07-17)
  await pool.query(`
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_labels JSONB DEFAULT '{}'
  `);
  // Introduction-derived identity provenance. Metadata points at already-
  // persisted transcript rows; it stores no transcript copy or duplicate
  // audio/recording.
  await pool.query(`
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_label_evidence JSONB NOT NULL DEFAULT '{}'
  `);
  // Persisted meeting title (used by MeetingPage, Home/history, transcript
  // downloads and Docs exports). Some live databases predate the title UI;
  // keeping this additive/idempotent boot migration here prevents their
  // PATCH route from failing with undefined_column while fresh and already-
  // migrated databases remain unchanged.
  await pool.query(`
    ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title TEXT
  `);
  // Uploaded-recording analysis reuses meetings.channel as an explicit type.
  // This repository has no production migration runner; ensureSessionsTable()
  // is the deploy-time schema gate, so mirror the additive SQL migration here.
  // No audio/blob column is added: the source recording remains in the browser.
  await pool.query(`
    ALTER TABLE meetings
      ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'in_person'
  `);
  await pool.query(`
    ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_channel_check
  `);
  await pool.query(`
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_channel_check
      CHECK (channel IN ('phone', 'in_person', 'uploaded_recording'))
  `);
  // Schedule-ahead metadata. Scheduled entries are normal meeting rows that
  // transition in place when started, preventing duplicate records.
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_timezone TEXT`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_name TEXT`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_phone TEXT`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_customer_address TEXT`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS scheduled_call_sid TEXT`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_meetings_upcoming_by_rep
    ON meetings (rep_id, scheduled_for ASC)
    WHERE scheduled_for IS NOT NULL AND status = 'active' AND scheduled_started_at IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_scheduled_call_sid_unique
    ON meetings (scheduled_call_sid) WHERE scheduled_call_sid IS NOT NULL
  `);
  // Word cadence / sequencing analytics (added 2026-08-02)
  await pool.query(`
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS word_count INTEGER
  `);
  await pool.query(`
    ALTER TABLE transcript_segments ADD COLUMN IF NOT EXISTS duration_ms INTEGER
  `);
  // Voice fingerprints table (Phase 5)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_prints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      features JSONB NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id)
    )
  `);
  // Phase 3: coaching snapshots table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coaching_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id UUID NOT NULL REFERENCES meetings(id),
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Soft-delete flag on users (added 2026-08-10, part of admin account
  // deletion feature — DELETE /api/admin/users/:id). Chose soft-delete over
  // hard delete because meetings.rep_id and customers.created_by are FK
  // references to users(id) with NO ON DELETE clause (see migrate.js): a
  // hard row DELETE would either FK-violate on any rep who has ever run a
  // meeting, or force us to null out those references and orphan meeting
  // attribution history (bad for a sales-coaching product where 'which rep
  // ran the meeting' IS the data). This nullable column lets us mark an
  // account as deleted while preserving all historical meeting/customer
  // attribution intact. Login and the preHandler user-lookup below both
  // filter WHERE deactivated_at IS NULL so a deactivated user can neither
  // sign in fresh nor continue an already-open session.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ
  `);
  // Rep phone number on file (added 2026-08-13, see
  // migrations/2026-08-13-users-phone.sql for the full rationale). Nullable
  // TEXT, stored E.164-normalized by the PATCH /api/profile handler below.
  // Lets PhoneCallModal.tsx prefill the "Your Phone Number" field from the
  // logged-in rep's saved number instead of asking them to retype it every
  // call.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT
  `);
  // Invites table (added 2026-08-10, part of the admin "invite a new user"
  // feature — POST /api/admin/invite). This is a STUB persistence layer
  // only: no email is actually sent by this route yet (see the route
  // comment below for the full explanation). Recording the invite here
  // lets us (a) show the admin a real success/pending state, and (b)
  // prevent duplicate invites to the same still-pending email, without
  // requiring any email-sending integration to exist yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('rep', 'admin')),
      invited_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked'))
    )
  `);
  // Case-insensitive dup-check support: one pending invite per email at a
  // time (a revoked/accepted row doesn't block a fresh re-invite).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS invites_pending_email_unique
    ON invites (LOWER(email))
    WHERE status = 'pending'
  `);

  // Invite claim codes (added 2026-08-18, see
  // migrations/2026-08-18-invite-claim-codes.sql for the full rationale).
  // This is NOT email verification — it's a one-time "claim code" an admin
  // relays to the invited rep out-of-band (text/in person); see the SQL
  // file header and POST /api/admin/invite's comment for the full model.
  // Mirrored here (ADD COLUMN IF NOT EXISTS, fully idempotent, no rewrite)
  // per this repo's established convention so a plain deploy-from-main
  // brings the schema in sync automatically without a manual migration
  // step — same safety net added for the objections/rebuttals tables above.
  await pool.query(`
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS claim_code_hash TEXT
  `);
  await pool.query(`
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS claim_attempts INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE invites ADD COLUMN IF NOT EXISTS claim_locked_until TIMESTAMPTZ
  `);

  // 'owner' role support (added 2026-08-10, Gabe's request — see the
  // hasAdminAccess()/isOwner() comment block for the full role model).
  //
  // Postgres has no "ALTER CHECK CONSTRAINT ... ADD VALUE": a CHECK
  // constraint (unlike a native ENUM type) must be dropped and recreated
  // with the widened value list. This is metadata-only — no table rewrite,
  // no row is touched — and is safe to run on a live table with rows
  // present, matching the DROP/ADD CONSTRAINT pattern already used in
  // migrations/2026-08-05-meeting-interrupted-status.sql.
  //
  // Runs on every boot and is fully idempotent: every existing row's role
  // is already 'rep' or 'admin', both of which remain valid under the
  // widened constraint, so this can never fail against existing data.
  // Kept here (rather than SQL-file-only) because this repo has no
  // migration runner — ensureSessionsTable() IS the de-facto migration
  // path that guarantees the constraint matches what the code expects,
  // so the deploy can't silently run ahead of the schema.
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check
  `);
  await pool.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('rep', 'admin', 'owner'))
  `);

  // Objections/Rebuttals library (added 2026-08-18, see
  // migrations/2026-08-18-objections-rebuttals.sql for the full schema
  // rationale). Mirrored here per this repo's established convention
  // (this whole function IS the de-facto migration runner, per the
  // 2026-08-10 owner-role comment above) so a plain deploy-from-main
  // brings the schema in sync automatically — this is the safety net the
  // 2026-08-17 recording-columns incident was missing (that migration's
  // ALTER TABLE was never mirrored here, so it silently never ran).
  // CREATE TABLE IF NOT EXISTS / IF NOT EXISTS index: fully idempotent,
  // non-destructive, safe on a live table with rows present or absent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS objections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      text TEXT NOT NULL,
      category TEXT,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rebuttals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      objection_id UUID NOT NULL REFERENCES objections(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rebuttals_objection_id_created_at_idx
    ON rebuttals (objection_id, created_at ASC)
  `);
}

async function createSession(userId) {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sessionId, userId, expiresAt]
  );
  return sessionId;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  const result = await pool.query(
    'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  return { userId: result.rows[0].user_id };
}

async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

// ─── Fastify setup ────────────────────────────────────────────────────────────

const fastify = Fastify({
  logger: { level: 'info' },
});

await fastify.register(cookie, {
  secret: SESSION_SECRET,
  hook: 'onRequest',
});

// 2026-08-04 (part 3-gpt fix): root cause of the mobile WS "connection
// failed" report that survived three prior fixes. React Native's WebSocket
// module ALWAYS sends an Origin header on the upgrade request, even though
// the app code sets no Origin explicitly:
//   - Android (WebSocketModule.kt getDefaultOrigin()): auto-derives
//     `https://<ws-host>` (i.e. the backend's OWN host) when no origin header
//     is set by the caller.
//   - Neither platform ever sends a browser-style Origin matching the Expo
//     tunnel/dev-server host that CORS_ORIGIN was configured to whitelist.
// The callback below used to reject with `cb(new Error(...), false)`.
// @fastify/cors treats an error from the origin resolver as a request-level
// failure and Fastify's default error handler returns a full HTTP 500
// response INSTEAD OF a normal CORS-rejected-but-still-200/101 response.
// For a WebSocket upgrade specifically, that 500 arrives instead of the 101
// Switching Protocols handshake, and RN's native WebSocket surfaces this as
// close code 1006, reason "Received bad response code from server: 500" —
// which is EXACTLY what Gabe's on-device logs showed after fix #3 correctly
// surfaced the real close code (see meeting.tsx onclose fix). Reproduced with
// 100% fidelity via a Node `ws` client sending Origin: https://<backend-host>
// (Android's auto-derived value) and Origin: null / file:// (other native
// clients) — all three hit this exact 500/"Not allowed by CORS" body.
// Fix: use `cb(null, false)` for a disallowed origin. @fastify/cors then
// completes the request normally (simply omitting the
// Access-Control-Allow-Origin header) instead of throwing a 500. This does
// NOT relax the CORS policy — disallowed origins still don't get the CORS
// header — it only stops turning a routine CORS mismatch into a hard 500
// that breaks WS upgrades for native clients whose Origin was never going to
// match the web-app whitelist in the first place. The WS route's own
// authWebSocket()/session check remains the actual auth gate; CORS here was
// never meant to be (and per fastify/cors's own contract, isn't) an auth
// mechanism for a non-browser client with no same-origin policy to enforce.
await fastify.register(cors, {
  origin: (origin, cb) => {
    const allowed = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!origin || allowed.length === 0 || allowed.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  credentials: true,
});

await fastify.register(websocketPlugin);

// Aria Phone Channel (Twilio) scaffolding — routes are registered
// unconditionally but self-gate on env vars internally (503/clear-close if
// unconfigured), same pattern as the existing Deepgram-gated WS route below.
// broadcastToMeeting is passed through unchanged (not modified, not
// wrapped) so phone-channel transcript/segment broadcasts fan out to the
// exact same owner + observer socket sets as the in-person flow, with zero
// changes to broadcastToMeeting() itself or the in-person audio handler.
// 2026-08-18 root-cause fix: pass the speaker-lock controller registry
// through too, so the phone-channel intro detector (telephony.js, wired up
// this pass — see introDetection.js header for why it never existed there
// before) can bridge its confirm/reject into the SAME
// POST /api/meetings/:id/speaker-lock route the in-person path already
// uses, with zero web-client changes required.
await registerTelephonyRoutes(fastify, { pool, registerMeetingSocket, unregisterMeetingSocket, broadcastToMeeting, registerSpeakerController, unregisterSpeakerController });

// ─── Auth middleware (decorator) ──────────────────────────────────────────────

fastify.decorateRequest('user', null);

fastify.addHook('preHandler', async (request, reply) => {
  // Attach user to request if session cookie present.
  // deactivated_at IS NULL filter (added 2026-08-10 with admin account-
  // delete feature) ensures a soft-deleted user's still-valid session
  // cookie stops resolving to a request.user, so requireAuth kicks them
  // out with 401 on their next authenticated request even if we didn't
  // catch/kill their session row on the delete side. Belt-and-suspenders
  // vs the DELETE handler's explicit session cleanup for that same user.
  const sessionId = request.cookies?.session_id;
  const session = await getSession(sessionId);
  if (session) {
    const result = await pool.query(
      'SELECT id, name, email, role, phone FROM users WHERE id = $1 AND deactivated_at IS NULL',
      [session.userId]
    );
    if (result.rows.length > 0) {
      request.user = result.rows[0];
    }
  }
});

async function requireAuth(request, reply) {
  if (!request.user) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

// ─── Role helpers ───────────────────────────────────────────────────────────
// Role model (2026-08-10, Gabe's request): 'rep' < 'admin' < 'owner'.
//
// 'owner' is a strict SUPERSET of 'admin' — it grants everything admin
// grants, plus exactly one extra capability (deleting admin accounts, see
// DELETE /api/admin/users/:id). It is NOT a separate parallel role, so
// every pre-existing `role === 'admin'` access check in this file must
// also accept 'owner' or the owner account would paradoxically have LESS
// access than a plain admin.
//
// These two helpers exist so that distinction is expressed once, in one
// place, instead of scattering `role === 'admin' || role === 'owner'`
// across ~30 call sites where a single missed site is a silent
// access-control bug. Rule of thumb for future edits:
//   - hasAdminAccess()  → use for ALL admin-gated behavior (the default)
//   - isOwner()         → use ONLY for the owner-exclusive capability
//
// There is exactly ONE owner (thacker@certapro.com) and the role is not
// assignable through any route or UI — it is set by a one-time data
// migration (see migrations/2026-08-10-owner-role.sql). Deliberately no
// 'owner' option in the invite role picker: an invite-able owner role
// would let any admin mint additional owners, contradicting the
// "should be the only owner" requirement.
function hasAdminAccess(role) {
  return role === 'admin' || role === 'owner';
}

function isOwner(role) {
  return role === 'owner';
}

// ─── Health ───────────────────────────────────────────────────────────────────

// ── Event-loop lag monitoring (2026-08-10, post-8/9-incident hardening) ──────
// WHY THIS EXISTS: the 8/9 outage produced a burst of 502s from Railway's
// proxy that started ~32 min BEFORE Railway's own US-West regional incident
// was declared, so the regional issue can't be the sole cause. The
// app-level evidence pointed at "connection dial timeout" to the single
// replica correlating with live-meeting load.
//
// The mechanism: this process does per-audio-word work (ring-buffer
// slicing, voice feature extraction, speaker-merge comparisons) on the
// SAME event loop that serves HTTP and relays the live meeting/Deepgram
// WebSockets. Under concurrent live-meeting load that work can starve the
// loop long enough that new connections — including Railway's own
// healthcheck probe — aren't accepted in time, and the proxy reports the
// replica as unreachable (502) even though the process is alive and the DB
// is fine.
//
// The old /health only proved "the process can reach Postgres." That is
// exactly the check that stays GREEN during this failure mode, because a
// starved loop still eventually completes a trivial `SELECT 1`. So the
// healthcheck could not distinguish "healthy" from "alive but too lagged to
// serve traffic" — the precise condition that was taking the service down.
//
// This sampler measures actual loop responsiveness: schedule a timer for
// EVENT_LOOP_SAMPLE_MS, then record how much LATER than that it actually
// fired. That delta is time the loop spent blocked on synchronous work.
// It is deliberately cheap (one timer, no allocation in the hot path) so
// the monitor itself can never become the load problem it is watching for.
const EVENT_LOOP_SAMPLE_MS = 500;
// Degraded threshold. Rationale: normal lag on an idle/healthy Node process
// is single-digit ms. Sustained lag above this means requests are already
// queueing behind synchronous work and connection accepts are at risk —
// i.e. this is the leading indicator of the 502 condition, caught while the
// process is still able to answer. Not so tight that a routine GC pause or
// a single heavy transcript segment trips it.
const EVENT_LOOP_LAG_DEGRADED_MS = 1000;

let eventLoopLagMs = 0;
let eventLoopLagMaxMs = 0;

// Debounced readiness signal derived from the SAME lag samples (no extra
// polling/timers of its own — see readinessTracker.js header for why this
// needs sustain/recovery windows instead of a raw threshold, and
// server/test/readinessTracker.test.mjs for the anti-flap proof). A throw
// out of this tracker must never take /health or /ready down with it —
// each call site below is wrapped so a bug in the readiness bookkeeping
// degrades to "we don't know, but the server still answers", never a 5xx
// from the observability code itself (brief requirement 6).
const readinessTracker = createReadinessTracker({
  log: (msg) => console.log(`[readiness] ${msg}`),
});

function startEventLoopLagSampler() {
  let expectedAt = Date.now() + EVENT_LOOP_SAMPLE_MS;
  const timer = setInterval(() => {
    const now = Date.now();
    // How late this tick actually fired vs. when it was scheduled. Clamped
    // at 0 because a timer can fire a hair early on some platforms.
    eventLoopLagMs = Math.max(0, now - expectedAt);
    if (eventLoopLagMs > eventLoopLagMaxMs) eventLoopLagMaxMs = eventLoopLagMs;
    expectedAt = now + EVENT_LOOP_SAMPLE_MS;
    try {
      readinessTracker.sample(eventLoopLagMs > EVENT_LOOP_LAG_DEGRADED_MS);
    } catch (e) {
      // Never let readiness bookkeeping take the sampler (or the process)
      // down. Worst case: /ready keeps reporting stale state until this
      // recovers on its own on a later tick.
      console.error(`[readiness] sample() threw, ignoring this tick: ${e.message}`);
    }
  }, EVENT_LOOP_SAMPLE_MS);
  // Never hold the process open just for telemetry.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

startEventLoopLagSampler();

// Root route for Railway health check
fastify.get('/', async (request, reply) => {
  return reply.code(200).send({ ok: true });
});

fastify.get('/health', async (request, reply) => {
  try {
    await pool.query('SELECT 1');

    // Report the loop's health alongside the DB's. A lagged loop is
    // reported as 'degraded' rather than 'error': the process IS still
    // serving (this very response proves it), so failing the healthcheck
    // outright would make Railway kill a replica that is merely busy —
    // during a live meeting that would drop in-flight audio WebSockets and
    // turn a slowdown into a hard outage. Surfacing it as degraded makes
    // the condition observable (and alertable) without that self-inflicted
    // restart loop. Deliberate call, flagged for Gabe/Troy: if we later
    // want Railway to auto-restart on sustained lag, that is a separate
    // decision requiring a second replica FIRST, otherwise a restart is a
    // guaranteed outage rather than a failover.
    const loopDegraded = eventLoopLagMs > EVENT_LOOP_LAG_DEGRADED_MS;

    return {
      status: loopDegraded ? 'degraded' : 'ok',
      db: 'connected',
      ts: new Date().toISOString(),
      eventLoop: {
        lagMs: eventLoopLagMs,
        maxLagMs: eventLoopLagMaxMs,
        thresholdMs: EVENT_LOOP_LAG_DEGRADED_MS,
        status: loopDegraded ? 'degraded' : 'ok',
      },
      activeMeetings: activeMeetingSockets.size,
      deepgram: DEEPGRAM_API_KEY ? 'configured' : 'missing',
      anthropic: anthropicPrimaryText.availability.anthropic,
      openrouter: anthropicPrimaryText.availability.openrouter,
      // Configuration availability only; this deliberately does not claim a
      // provider is funded or reachable merely because an env var exists.
      summaryGeneration: {
        status: anthropicPrimaryText.availability.textGeneration,
        runtimeVerified: false,
        primary: ANTHROPIC_API_KEY ? 'anthropic' : OPENROUTER_API_KEY ? 'openrouter' : null,
        fallback: ANTHROPIC_API_KEY && OPENROUTER_API_KEY ? 'openrouter' : null,
      },
      pyannote: pyannote.isConfigured() ? 'configured' : 'missing (scaffolded, inactive)',
      twilio: (() => {
        const s = twilioConfigStatus();
        return s.status === 'configured' ? 'configured' : `${s.status} (missing: ${s.missing.join(', ')})`;
      })(),
    };
  } catch (err) {
    reply.code(503).send({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// GET /ready — SEPARATE from /health, and deliberately not something any
// restart-triggering healthcheck (Railway's included) should point at while
// this service is single-replica. See the module-level note above
// EVENT_LOOP_SAMPLE_MS and readinessTracker.js for the full reasoning; the
// short version:
//
//   /health  = liveness. "Is the process alive and can it reach the DB?"
//              Stays 200 even when degraded — this is what should keep
//              Railway from restarting the only replica mid-call.
//   /ready   = readiness. "Has this instance been SUSTAINABLY degraded long
//              enough that traffic should stop being routed to it / a human
//              or a load balancer should react?" Returns 503 only after the
//              debounced readinessTracker (10s sustained degraded, 5s
//              sustained recovery by default — see readinessTracker.js) has
//              flipped, so a single lag spike never trips it.
//
// Chosen path is /ready (not /health/ready) to match the conventional
// Kubernetes-style liveness/readiness naming most infra people and tools
// already recognize, and to make it trivially easy to point a FUTURE
// second-replica load balancer or Railway readiness check at a single flat
// path without nesting it under /health's URL space (the two are
// deliberately separate resources, not sub-resources of one another).
//
// Cheap by construction (brief requirement 5): reads two already-computed
// in-memory values (readinessTracker.isReady() + eventLoopLagMs), no DB
// query, no new timer, no allocation beyond the response object itself.
fastify.get('/ready', async (request, reply) => {
  let ready = true;
  let state = null;
  try {
    ready = readinessTracker.isReady();
    state = readinessTracker.getState();
  } catch (err) {
    // Requirement 6: a throw in the tracker must be a no-op, never a 5xx
    // from the observability code itself. Fail OPEN (report ready) rather
    // than fail closed here, because failing closed on an observability
    // bug would risk exactly the kind of self-inflicted routing/alerting
    // flap this feature exists to prevent — if a future consumer ever
    // points a restart-capable check at /ready, a false "ready" is far
    // safer than a false "not ready" causing action against a healthy box.
    console.error(`[readiness] /ready tracker read threw, failing open: ${err.message}`);
    ready = true;
    state = { error: err.message };
  }

  const body = {
    status: ready ? 'ready' : 'not_ready',
    eventLoop: {
      lagMs: eventLoopLagMs,
      thresholdMs: EVENT_LOOP_LAG_DEGRADED_MS,
    },
    readiness: state,
  };

  if (ready) {
    return body;
  }
  return reply.code(503).send(body);
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

fastify.post('/api/auth/login', async (request, reply) => {
  const { email, password } = request.body || {};

  if (!email || !password) {
    return reply.code(400).send({ error: 'email and password are required' });
  }

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const user = result.rows[0];
  // Deactivated accounts (soft-deleted via DELETE /api/admin/users/:id) must
  // not be able to log in. Deliberately return the SAME 401 'Invalid
  // credentials' message as a wrong-password attempt to avoid leaking
  // account-state information (i.e. so a random attacker can't distinguish
  // 'user was deleted' from 'user never existed / wrong password').
  if (user.deactivated_at) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return reply.code(401).send({ error: 'Invalid credentials' });
  }

  const sessionId = await createSession(user.id);

  reply
    .setCookie('session_id', sessionId, {
      httpOnly: true,
      path: '/',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400, // 24h
    })
    .send({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      // Mobile-only fallback (see authWebSocket note above) — the web PWA's
      // fetch client never reads this field and continues to rely solely on
      // the httpOnly cookie, so this is not a new client-readable-cookie
      // security regression for the web app. It IS a new client-visible
      // credential for the mobile app specifically; mobile stores it in
      // expo-secure-store (OS-level encrypted storage), not plain state.
      sessionId,
    });
});

fastify.post('/api/auth/logout', async (request, reply) => {
  const sessionId = request.cookies?.session_id;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  reply
    .clearCookie('session_id', { path: '/' })
    .send({ ok: true });
});

fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
  // Mobile-only session-id backfill (2026-08-04): the native-client WS auth
  // fallback (see authWebSocket()) requires the raw session id, which is
  // only ever handed to the client in the /api/auth/login response body.
  // Any mobile session established BEFORE that fallback shipped (or any
  // future case where secure-store gets cleared without a fresh login) has
  // no sessionId cached, silently falling back to cookie-only WS auth --
  // the exact bug this was meant to fix. Returning it here too lets the
  // mobile client backfill it on every authenticated app-open, without
  // forcing a log-out/log-in cycle. The web PWA's api.ts ignores unknown
  // response fields, so this is additive and does not change its behavior.
  return { user: request.user, sessionId: request.cookies?.session_id };
});

// PATCH /api/account/password — self-service password change.
// Requires the CURRENT password to be re-verified server-side before the
// change is applied (standard defense-in-depth: a hijacked/stolen session
// cookie alone is not sufficient to lock the real owner out by rotating
// their password). Works for any authenticated user regardless of role
// (rep or admin) — this is a self-service "change MY OWN password" route,
// not an admin-changes-another-user's-password route (that's part of the
// separate, not-yet-built "add/delete accounts" admin-management work).
fastify.patch('/api/account/password', { preHandler: [requireAuth] }, async (request, reply) => {
  const { currentPassword, newPassword } = request.body || {};

  if (!currentPassword || !newPassword) {
    return reply.code(400).send({ error: 'currentPassword and newPassword are required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return reply.code(400).send({ error: 'newPassword must be at least 8 characters' });
  }

  const result = await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [request.user.id]);
  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  const user = result.rows[0];

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    return reply.code(401).send({ error: 'Current password is incorrect' });
  }

  const sameAsOld = await bcrypt.compare(newPassword, user.password_hash);
  if (sameAsOld) {
    return reply.code(400).send({ error: 'New password must be different from the current password' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

  return { ok: true };
});

// PATCH /api/profile — self-service profile fields. Currently just `phone`
// (added 2026-08-13 so PhoneCallModal.tsx can prefill the rep's own number
// instead of asking them to retype it every call — see
// migrations/2026-08-13-users-phone.sql). Same self-service pattern as
// PATCH /api/account/password above: any authenticated user (rep or admin)
// can update their OWN row, no role check needed.
//
// Validation is loose by design: accept E.164 ("+16165551234") or common
// US-formatted input ("(616) 555-1234", "616-555-1234", "6165551234") via
// telephony.js's normalizePhoneNumber() (libphonenumber-js, US default
// region) — the SAME normalizer already used for caller-ID matching, so
// there's exactly one phone-parsing implementation in this codebase, not
// two. An empty string or null clears the field (rep hasn't set one / wants
// to unset it) rather than erroring. A non-empty value that fails to parse
// is a 400, not a silent store of garbage.
fastify.patch('/api/profile', { preHandler: [requireAuth] }, async (request, reply) => {
  const { phone } = request.body || {};

  let normalizedPhone = null;
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    normalizedPhone = normalizePhoneNumber(String(phone));
    if (!normalizedPhone) {
      return reply.code(400).send({ error: 'Enter a valid phone number, e.g. (616) 555-1234' });
    }
  }

  const result = await pool.query(
    'UPDATE users SET phone = $1 WHERE id = $2 RETURNING id, name, email, role, phone',
    [normalizedPhone, request.user.id]
  );

  return { user: result.rows[0] };
});

// ─── Admin: user management ─────────────────────────────────────────────────
// Admin-only surface for listing accounts and soft-deleting them. Currently
// exposes GET + DELETE only; the queued follow-up work will add POST
// (create account) on this same URL prefix. Both routes gate on
// requireAuth first, then explicitly re-check role === 'admin' inside the
// handler (same pattern used everywhere else in this file for admin-only
// branches, e.g. GET /api/meetings, GET /api/customers).
//
// Soft-delete rationale (see also the ALTER TABLE users ADD COLUMN
// deactivated_at note in ensureSessionsTable()): meetings.rep_id and
// customers.created_by reference users(id) with NO ON DELETE clause,
// so a hard row DELETE either FK-violates or forces orphaning historical
// attribution. This route flips deactivated_at to NOW() instead and
// atomically kills any live sessions for the target user so a
// currently-signed-in deactivated user is booted on their next request.

fastify.get('/api/admin/users', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
  const result = await pool.query(
    `SELECT id, name, email, role, created_at, deactivated_at
     FROM users
     ORDER BY deactivated_at IS NULL DESC, created_at DESC`
  );
  return { users: result.rows };
});

fastify.delete('/api/admin/users/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
  const { id } = request.params;

  // Guard 1: an admin cannot delete their own account. Doing so mid-session
  // would also potentially strand the tenant with zero admins (see guard 2)
  // and is a foot-gun regardless — self-deactivation should be its own
  // deliberate flow, not a side effect of the user-list delete button.
  if (id === request.user.id) {
    return reply.code(400).send({ error: 'You cannot delete your own account' });
  }

  // Look up the target and enforce guard 2 in the same transaction-ish
  // window. Race note: two concurrent admin-delete requests targeting the
  // last two admins could each read admin_count=2 and each proceed to
  // deactivate their target, leaving the tenant with zero admins. Fixed
  // by re-checking admin_count AFTER the UPDATE inside the same connection
  // and rolling back if it dropped to zero.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query(
      'SELECT id, name, email, role, deactivated_at FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (targetResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return reply.code(404).send({ error: 'User not found' });
    }
    const target = targetResult.rows[0];
    if (target.deactivated_at) {
      await client.query('ROLLBACK');
      return reply.code(400).send({ error: 'User is already deactivated' });
    }

    // Guard 2 (added 2026-08-10, Gabe's request): only the OWNER may remove
    // an admin-level account. A plain admin can still deactivate 'rep'
    // accounts exactly as before — this restriction deliberately applies
    // ONLY to admin-level targets, which is the specific thing that was
    // asked for ("the only account that can delete admin accounts").
    //
    // Checked against the TARGET's role, and 'owner' is included in the
    // protected set so that a plain admin cannot deactivate the owner
    // account either (the owner outranks them; letting an admin delete
    // their superior would invert the hierarchy). Note isOwner() — not
    // hasAdminAccess() — on the requester: this is the one capability in
    // the system that admin does NOT inherit.
    //
    // Ordering matters: this runs AFTER the target lookup (we need the
    // target's role) and BEFORE the last-admin count guard, so an
    // unauthorized caller gets the accurate 403 rather than leaking
    // "last remaining admin" state. The self-delete guard above still
    // applies first and independently — the owner cannot delete their own
    // account via this route either.
    if (hasAdminAccess(target.role) && !isOwner(request.user.role)) {
      await client.query('ROLLBACK');
      return reply.code(403).send({
        error: 'Only the account owner can remove admin accounts'
      });
    }

    // Guard 3: never let the last active admin be deactivated. Counted
    // BEFORE the update so an already-deactivated admin doesn't count.
    // Counts 'owner' alongside 'admin' since the owner IS an admin for
    // every access-control purpose — excluding it here would let the
    // last plain admin be removed while an active owner exists, wrongly
    // reporting the tenant as admin-less.
    if (hasAdminAccess(target.role)) {
      const adminCount = await client.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE role IN ('admin', 'owner') AND deactivated_at IS NULL"
      );
      if (adminCount.rows[0].n <= 1) {
        await client.query('ROLLBACK');
        return reply.code(400).send({
          error: 'Cannot delete the last remaining admin account'
        });
      }
    }

    // Soft-delete: flip the flag, keep the row.
    await client.query(
      'UPDATE users SET deactivated_at = NOW() WHERE id = $1',
      [id]
    );

    // Race-condition post-check (see comment above).
    const postCheck = await client.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE role IN ('admin', 'owner') AND deactivated_at IS NULL"
    );
    if (postCheck.rows[0].n < 1) {
      await client.query('ROLLBACK');
      return reply.code(400).send({
        error: 'Cannot delete the last remaining admin account'
      });
    }

    // Kill any live sessions for the deactivated user so an already-signed-
    // in tab loses auth on its next request (belt to the preHandler's
    // suspenders that also filters deactivated_at IS NULL).
    const sessKill = await client.query(
      'DELETE FROM sessions WHERE user_id = $1 RETURNING id',
      [id]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        role: target.role,
      },
      sessions_revoked: sessKill.rowCount,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    request.log.error({ err }, 'admin delete user failed');
    return reply.code(500).send({ error: 'Failed to delete user' });
  } finally {
    client.release();
  }
});

// ─── Invite claim codes (2026-08-18) ───────────────────────────────────────
//
// BE PRECISE ABOUT WHAT THIS IS: this is NOT email verification. It does
// not prove the invited person controls the invited mailbox. It proves
// they know an email an admin typed AND hold a one-time secret code that
// was relayed to them out-of-band (text message or in person). Everywhere
// below and in the aria-web UI, this is called "invite claim" / "claim
// code", never "verification" or "signup link" — see this task's report
// for why (no email-sending capability anywhere in this codebase, no
// verified sending domain, no stable public web URL yet — Vercel SSO
// currently 302s the canonical URL). Gabe's explicit 2026-08-18 decision:
// ship this now so account signup actually works; real email-based
// verification is future work once an email service + stable URL exist.
// Password reset is explicitly deferred for the same reason.
//
// Claim code format: 6 characters, uppercase, drawn from an alphabet with
// ambiguous characters removed (0/O, 1/I/L) — see CLAIM_CODE_ALPHABET —
// because a human reads this over the phone or a text message. Generated
// with crypto.randomInt (CSPRNG), never Math.random(). Only a bcrypt HASH
// of the code is ever stored (claim_code_hash); the plaintext is returned
// in this route's response exactly once and is not retrievable again —
// same model as an API key. See migrations/2026-08-18-invite-claim-codes.sql.

const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const CLAIM_CODE_LENGTH = 6;
const CLAIM_CODE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const CLAIM_MAX_ATTEMPTS = 8; // per-invite failed-attempt threshold before lockout
const CLAIM_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function generateClaimCode() {
  let code = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    code += CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)];
  }
  return code;
}

// In-memory per-IP limiter for the public claim endpoint (below). It has no
// account/session to key off of by definition (the whole point is the rep
// doesn't have an account yet), so this is independent of every other auth
// mechanism in this file. Deliberately in-process/in-memory, matching this
// codebase's existing appetite for lightweight in-memory state over adding
// a new dependency (e.g. no Redis anywhere in this project) — acceptable
// here because it's a coarse abuse-throttle, not a correctness boundary;
// the real single-use/expiry/lockout guarantees live in the DB transaction
// below. Resets on process restart, which is fine for this purpose.
const claimAttemptsByIp = new Map(); // ip -> { count, windowStart }
const CLAIM_IP_WINDOW_MS = 15 * 60 * 1000;
const CLAIM_IP_MAX_ATTEMPTS = 20;

function claimIpRateLimited(ip) {
  const now = Date.now();
  const entry = claimAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > CLAIM_IP_WINDOW_MS) {
    claimAttemptsByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > CLAIM_IP_MAX_ATTEMPTS;
}

// Generic, timing-similar failure for every claim-failure path (unknown
// email, no pending invite, wrong code, expired, already accepted, locked
// out). SECURITY: if "not invited" and "wrong code" were distinguishable,
// this public endpoint would be an allowlist enumerator — a stranger could
// submit random emails and learn which ones an admin has invited. Always
// return this exact same shape/message/status code from every failure
// branch below.
const CLAIM_GENERIC_ERROR = 'Invalid email, claim code, or the invite has expired.';
function claimGenericFailure(reply) {
  return reply.code(400).send({ error: CLAIM_GENERIC_ERROR });
}

// POST /api/admin/invite — create an invite AND a one-time claim code.
//
// Persists an `invites` row (status='pending') exactly as before, plus:
// generates a plaintext claim code, stores only its bcrypt hash, and sets
// a 72h expiry. The PLAINTEXT code is returned in this response ONCE —
// the admin UI must display it immediately (with a copy button) because
// there is no way to retrieve it again short of the regenerate action
// below, which invalidates the old code and mints a new one.
fastify.post('/api/admin/invite', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }

  const { email, role } = request.body || {};

  if (typeof email !== 'string' || !email.trim()) {
    return reply.code(400).send({ error: 'email is required' });
  }
  // Same pragmatic email-format check used client-side — kept intentionally
  // simple (not a full RFC 5322 validator) since the only thing that
  // matters server-side is "not obviously garbage", the same bar other
  // routes in this file hold user-supplied strings to.
  const normalizedEmail = email.trim().toLowerCase();
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_RE.test(normalizedEmail)) {
    return reply.code(400).send({ error: 'Please enter a valid email address' });
  }

  if (role !== 'admin' && role !== 'rep') {
    return reply.code(400).send({ error: 'role must be "admin" or "rep"' });
  }

  // Guard 1: an account with this email already exists (active OR
  // deactivated — re-inviting a soft-deleted email is a deliberate
  // separate decision, not this button's job).
  const existingUser = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = $1',
    [normalizedEmail]
  );
  if (existingUser.rows.length > 0) {
    return reply.code(409).send({ error: 'An account with this email already exists' });
  }

  // Guard 2: an invite for this email is already pending.
  const existingInvite = await pool.query(
    "SELECT id FROM invites WHERE LOWER(email) = $1 AND status = 'pending'",
    [normalizedEmail]
  );
  if (existingInvite.rows.length > 0) {
    return reply.code(409).send({ error: 'An invite is already pending for this email' });
  }

  const claimCode = generateClaimCode();
  const claimCodeHash = await bcrypt.hash(claimCode, 10);
  const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);

  try {
    const result = await pool.query(
      `INSERT INTO invites (email, role, invited_by, status, claim_code_hash, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING id, email, role, invited_by, created_at, status, expires_at`,
      [normalizedEmail, role, request.user.id, claimCodeHash, expiresAt]
    );
    return reply.code(201).send({
      ok: true,
      invite: result.rows[0],
      // Plaintext claim code — returned ONCE, here, and never again. The
      // admin must relay it to the rep out-of-band (text/in person) right
      // now; if it's lost, use the regenerate action to mint a new one.
      claimCode,
    });
  } catch (err) {
    // Race-condition backstop: the partial unique index on
    // (LOWER(email)) WHERE status='pending' catches a concurrent
    // double-submit that both passed the guard-2 SELECT above.
    if (err.code === '23505') {
      return reply.code(409).send({ error: 'An invite is already pending for this email' });
    }
    request.log.error({ err }, 'admin invite failed');
    return reply.code(500).send({ error: 'Failed to record invite' });
  }
});

// GET /api/admin/invites — list invites (admin only) so the UI can show
// pending invites with their expiry and offer regenerate/revoke actions.
// Deliberately excludes claim_code_hash from the SELECT — even hashed,
// there's no reason to ever ship it to a client.
fastify.get('/api/admin/invites', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
  const result = await pool.query(
    `SELECT id, email, role, invited_by, created_at, status, expires_at, accepted_at
     FROM invites
     ORDER BY created_at DESC`
  );
  return { invites: result.rows };
});

// POST /api/admin/invites/:id/regenerate — mint a fresh claim code for an
// existing pending invite, invalidating the previous code (overwrites
// claim_code_hash) and resetting the expiry + attempt counter. Same
// one-time plaintext-in-response model as invite creation.
fastify.post('/api/admin/invites/:id/regenerate', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
  const { id } = request.params;

  const existing = await pool.query(
    "SELECT id, status FROM invites WHERE id = $1",
    [id]
  );
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Invite not found' });
  }
  if (existing.rows[0].status !== 'pending') {
    return reply.code(400).send({ error: 'Only a pending invite can have its claim code regenerated' });
  }

  const claimCode = generateClaimCode();
  const claimCodeHash = await bcrypt.hash(claimCode, 10);
  const expiresAt = new Date(Date.now() + CLAIM_CODE_TTL_MS);

  const result = await pool.query(
    `UPDATE invites
     SET claim_code_hash = $1, expires_at = $2, claim_attempts = 0, claim_locked_until = NULL
     WHERE id = $3
     RETURNING id, email, role, invited_by, created_at, status, expires_at`,
    [claimCodeHash, expiresAt, id]
  );

  return { ok: true, invite: result.rows[0], claimCode };
});

// POST /api/admin/invites/:id/revoke — wire up the existing 'revoked'
// status value (it was defined on the table from the start but nothing
// ever set it). A revoked invite's claim code stops working immediately
// (the claim route below only ever matches status = 'pending').
fastify.post('/api/admin/invites/:id/revoke', { preHandler: [requireAuth] }, async (request, reply) => {
  if (!hasAdminAccess(request.user.role)) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
  const { id } = request.params;

  const result = await pool.query(
    `UPDATE invites SET status = 'revoked' WHERE id = $1 AND status = 'pending'
     RETURNING id, email, role, created_at, status`,
    [id]
  );
  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Pending invite not found' });
  }
  return { ok: true, invite: result.rows[0] };
});

// POST /api/signup/claim — PUBLIC, unauthenticated. The other half of the
// invite flow: a rep who has been given an email + claim code out-of-band
// submits (email, claim code, new password) to actually create their
// account. On success this is fully atomic (single DB transaction): the
// invite row is locked with SELECT ... FOR UPDATE, the user is created,
// the password is hashed the same way login does (bcryptjs), and the
// invite is flipped to status='accepted' with accepted_at set — all or
// nothing, and the row lock means two simultaneous claims of the same
// invite cannot both succeed (the second blocks on FOR UPDATE, then sees
// status='accepted' once it proceeds and fails the same generic way).
//
// SECURITY — every failure path below returns the exact same generic
// error (CLAIM_GENERIC_ERROR) and status code, whether the cause is an
// unknown email, an expired invite, a wrong code, an already-claimed
// invite, or a locked-out invite. If these were distinguishable this
// public endpoint would let a stranger enumerate which emails an admin
// has invited — see the CLAIM_GENERIC_ERROR comment above.
fastify.post('/api/signup/claim', async (request, reply) => {
  const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
  if (claimIpRateLimited(ip)) {
    return reply.code(429).send({ error: 'Too many attempts. Please try again later.' });
  }

  const { email, claimCode, password } = request.body || {};

  if (typeof email !== 'string' || !email.trim() ||
      typeof claimCode !== 'string' || !claimCode.trim() ||
      typeof password !== 'string') {
    return claimGenericFailure(reply);
  }

  // Minimum password length: this codebase has no dedicated "signup"
  // password policy anywhere yet, so this follows the one that DOES exist
  // — PATCH /api/account/password's 8-character minimum (see also
  // ProfilePage.tsx's matching client-side check).
  if (password.length < 8) {
    return reply.code(400).send({ error: 'Password must be at least 8 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedCode = claimCode.trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inviteResult = await client.query(
      `SELECT * FROM invites WHERE LOWER(email) = $1 AND status = 'pending' FOR UPDATE`,
      [normalizedEmail]
    );

    if (inviteResult.rows.length === 0) {
      // Unknown email OR no pending invite for it — same generic failure
      // as every other branch below.
      await client.query('ROLLBACK');
      return claimGenericFailure(reply);
    }

    const invite = inviteResult.rows[0];

    // Per-invite lockout (independent of the per-IP limiter above — this
    // one persists across IPs/processes since it's in the DB row itself).
    if (invite.claim_locked_until && new Date(invite.claim_locked_until) > new Date()) {
      await client.query('ROLLBACK');
      return claimGenericFailure(reply);
    }

    if (!invite.claim_code_hash || !invite.expires_at || new Date(invite.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return claimGenericFailure(reply);
    }

    const codeValid = await bcrypt.compare(normalizedCode, invite.claim_code_hash);
    if (!codeValid) {
      const attempts = invite.claim_attempts + 1;
      const lockedUntil =
        attempts >= CLAIM_MAX_ATTEMPTS ? new Date(Date.now() + CLAIM_LOCKOUT_MS) : null;
      await client.query(
        `UPDATE invites SET claim_attempts = $1, claim_locked_until = $2 WHERE id = $3`,
        [attempts, lockedUntil, invite.id]
      );
      await client.query('COMMIT');
      return claimGenericFailure(reply);
    }

    // Guard: an account with this email was created some other way after
    // the invite was issued (e.g. two invites races is prevented by the
    // partial unique index, but belt-and-suspenders here too).
    const existingUser = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return claimGenericFailure(reply);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // Derive the account name from the email's local-part as a placeholder
    // — there is no "name" field collected anywhere in this flow (admin
    // invite only asks for email + role). The rep can update their name
    // later via ProfilePage if that field is ever exposed there.
    const derivedName = normalizedEmail.split('@')[0];

    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role`,
      [derivedName, normalizedEmail, passwordHash, invite.role]
    );

    await client.query(
      `UPDATE invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [invite.id]
    );

    await client.query('COMMIT');

    return reply.code(201).send({ ok: true, user: userResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    request.log.error({ err }, 'signup claim failed');
    return reply.code(500).send({ error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

// ─── Voice print routes ─────────────────────────────────────────────────────────

// GET /api/profile/voice-print — check enrollment status
fastify.get('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  const result = await pool.query(
    'SELECT id, duration_ms, created_at FROM voice_prints WHERE user_id = $1',
    [request.user.id]
  );
  if (result.rows.length === 0) return { enrolled: false };
  const vp = result.rows[0];
  return { enrolled: true, duration_ms: vp.duration_ms, created_at: vp.created_at };
});

// POST /api/profile/voice-print — enroll or re-enroll
// Body: { features: {...}, duration_ms: number }
fastify.post('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  const { features, duration_ms } = request.body || {};
  if (!features || !duration_ms) return reply.code(400).send({ error: 'features and duration_ms required' });
  // Upsert — one print per user
  await pool.query(
    `INSERT INTO voice_prints (user_id, features, duration_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET features = $2, duration_ms = $3, created_at = NOW()`,
    [request.user.id, JSON.stringify(features), duration_ms]
  );
  return { ok: true };
});

// DELETE /api/profile/voice-print — remove enrollment
fastify.delete('/api/profile/voice-print', { preHandler: [requireAuth] }, async (request, reply) => {
  await pool.query('DELETE FROM voice_prints WHERE user_id = $1', [request.user.id]);
  return { ok: true };
});

// ─── Meeting routes ───────────────────────────────────────────────────────────

await registerScheduledMeetingRoutes(fastify, {
  pool, requireAuth, hasAdminAccess, shapeMeetingForClient, normalizePhoneNumber,
});

fastify.post('/api/meetings', { preHandler: [requireAuth] }, async (request, reply) => {
  const { customer_id, origin_client, channel } = request.body || {};
  const repId = request.user.id;

  // (2026-08-10) `channel` — reuses the EXISTING `meetings.channel` column
  // (see migrations/2026-08-04-phone-channel-columns.sql — despite that
  // file's own "PROPOSED / SKETCH ONLY" header, this column IS live in prod;
  // confirmed via a direct information_schema query against the meetings
  // table). Previously NO caller (mobile or web) ever sent this field, so
  // every meeting silently fell through to the column's DB default,
  // `'in_person'` — including phone-channel meetings once mobile adds a
  // caller that can actually set 'phone' (see the new pre-record
  // meeting-setup step in mobile/src/app/meeting-setup.tsx). Validated
  // against the same CHECK constraint values the column already enforces
  // so a bad/typo'd value fails fast with a clear 400 here rather than a
  // less legible Postgres constraint-violation error.
  const validChannels = ['in_person', 'phone'];
  if (channel !== undefined && !validChannels.includes(channel)) {
    return reply.code(400).send({ error: `Invalid channel "${channel}" — must be one of: ${validChannels.join(', ')}` });
  }
  const meetingChannel = channel || 'in_person';

  // ── Live meeting sync (mobile → web), 2026-08-05 ──────────────────────────
  // `owner_session_id` records WHICH logged-in session created this meeting
  // (the requesting session's own session_id — see the global preHandler
  // hook above; both the web PWA and the mobile app authenticate normal
  // fetch() calls like this one via the same httpOnly session cookie, per
  // mobile/src/lib/api.ts's auth-model doc — only the WS audio upgrade
  // needed a query-param fallback, not this route). `origin_client` records
  // WHICH APP started it ('mobile' vs 'web') so the sync/observe feature
  // below can be scoped to mobile-originated meetings only, per this pass's
  // explicit v1 scope (mobile→web sync only, no web→mobile reverse sync).
  // Both columns are new, additive, nullable/defaulted (see
  // migrations/2026-08-05-meeting-owner-session-sync.sql, NOT applied to
  // prod yet) — insert defensively so meeting creation still works even
  // before that migration lands (undefined_column, Postgres code 42703).
  const ownerSessionId = request.cookies?.session_id || null;
  const originClient = origin_client === 'mobile' ? 'mobile' : 'web';

  let meetingRow;
  try {
    const result = await pool.query(
      `INSERT INTO meetings (customer_id, rep_id, status, owner_session_id, origin_client, channel)
       VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING *`,
      [customer_id || null, repId, ownerSessionId, originClient, meetingChannel]
    );
    meetingRow = result.rows[0];
  } catch (err) {
    if (err.code === '42703') {
      // owner_session_id/origin_client/channel columns not yet migrated in
      // this DB — fall back to the pre-sync-feature insert so meeting
      // creation is never blocked on a pending migration. Note: on this
      // fallback path the caller's `channel` choice is silently dropped
      // (same pre-existing behavior as origin_client on this path) since
      // the column doesn't exist yet to write it to.
      fastify.log.warn('meetings.owner_session_id/origin_client/channel columns missing (migration pending) — creating meeting without sync tracking or channel.');
      const fallback = await pool.query(
        `INSERT INTO meetings (customer_id, rep_id, status)
         VALUES ($1, $2, 'active')
         RETURNING *`,
        [customer_id || null, repId]
      );
      meetingRow = fallback.rows[0];
    } else {
      throw err;
    }
  }

  // Notify any OTHER logged-in session for this same user_id that a
  // mobile-originated meeting just started, so it can surface the
  // read-only synced dialog (see the /api/sync WS route below). Only fires
  // for origin_client === 'mobile' — web-started meetings intentionally do
  // NOT sync to other sessions in this pass (v1 scope, see report). Uses
  // the `originClient` local (what we INTENDED to insert), not
  // `meetingRow.origin_client` (which is `undefined` on the pre-migration
  // fallback insert path above, since that INSERT/RETURNING never selects
  // a column that doesn't exist yet) — both paths still correctly notify
  // once the column is live, since the intended value is unaffected by
  // whether the DB could persist it yet.
  if (originClient === 'mobile') {
    notifyUserSyncMeetingStarted(repId, meetingRow);
  }

  return reply.code(201).send(shapeMeetingForClient(meetingRow, ownerSessionId));
});

// GET /api/meetings — 2026-08-07: added limit+offset pagination so older
// meetings (beyond the frontend's original unbounded-but-effectively-
// "recent" list) become reachable. Chosen over cursor-based pagination as
// the lowest-risk option matching this endpoint's existing simple
// SELECT + ORDER BY started_at DESC pattern — no new indexes or schema
// changes required, and started_at DESC + LIMIT/OFFSET is stable enough
// for a rep's own meeting history (no concurrent high-frequency inserts
// racing pagination the way a global feed might see).
// Fetches `limit + 1` rows so `hasMore` can be derived from the extra row
// without a separate COUNT(*) query, then trims back to `limit` before
// responding. Response shape changed from a bare array to
// `{ meetings, hasMore, limit, offset }` — the only frontend consumer
// (web/src/lib/api.ts's listMeetings()) is updated in this same pass.
fastify.get('/api/meetings', { preHandler: [requireAuth] }, async (request, reply) => {
  const { role, id } = request.user;

  const rawLimit = parseInt(request.query?.limit, 10);
  const rawOffset = parseInt(request.query?.offset, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  let result;

  if (hasAdminAccess(role)) {
    result = await pool.query(
      `SELECT m.*, u.name as rep_name, c.name as customer_name
       FROM meetings m
       LEFT JOIN users u ON m.rep_id = u.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.scheduled_for IS NULL OR m.scheduled_started_at IS NOT NULL
       ORDER BY m.started_at DESC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
    );
  } else {
    result = await pool.query(
      `SELECT m.*, u.name as rep_name, c.name as customer_name
       FROM meetings m
       LEFT JOIN users u ON m.rep_id = u.id
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.rep_id = $1
         AND (m.scheduled_for IS NULL OR m.scheduled_started_at IS NOT NULL)
       ORDER BY m.started_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit + 1, offset]
    );
  }

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  const requestSessionId = request.cookies?.session_id || null;
  return {
    meetings: rows.map(row => shapeMeetingForClient(row, requestSessionId)),
    hasMore,
    limit,
    offset,
  };
});

// ── Live meeting sync (mobile → web), 2026-08-05: REST catch-up/fallback ────
// GET /api/meetings/active-sync — "is there a mobile-originated meeting
// active for MY account right now". Exists alongside the WS push
// (GET /api/sync's connect-time catch-up check does the same query) as a
// deliberate short-polling-friendly fallback per this task's architecture
// notes: if a client's /api/sync WS connection is slow to establish, drops,
// or a given surface finds it simpler to poll this on an interval (e.g.
// every 15-20s) rather than hold a dedicated always-on socket just for
// this one low-frequency check, that's an explicitly acceptable v1 choice
// (see report for the full reasoning) — the actual live transcript/
// coaching feed for a meeting the user IS watching still always goes over
// the real-time /meetings/:id/observe WS, never polling.
fastify.get('/api/meetings/active-sync', { preHandler: [requireAuth] }, async (request, reply) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.customer_id, m.started_at, m.title, c.name as customer_name
       FROM meetings m
       LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.rep_id = $1 AND m.status = 'active' AND m.origin_client = 'mobile'
       ORDER BY m.started_at DESC LIMIT 1`,
      [request.user.id]
    );
    if (result.rows.length === 0) return { active: null };
    return { active: result.rows[0] };
  } catch (err) {
    if (err.code === '42703') {
      // origin_client column not yet migrated — no mobile-originated
      // meetings can exist yet either way, so "none active" is correct.
      return { active: null };
    }
    throw err;
  }
});

fastify.get('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const result = await pool.query(
    `SELECT m.*, u.name as rep_name, c.name as customer_name
     FROM meetings m
     LEFT JOIN users u ON m.rep_id = u.id
     LEFT JOIN customers c ON m.customer_id = c.id
     WHERE m.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = result.rows[0];

  // Reps can only see their own meetings
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  return shapeMeetingForClient(meeting, request.cookies?.session_id || null);
});

// Statuses that FINALIZE a meeting (stop it from being live/editable in the
// same sense an active meeting is). Used below to gate the "only the
// device that started it can end it" rule from the live-meeting-sync
// feature (2026-08-05) — see report for the full security rationale and a
// real end-to-end test proving a non-owning session gets rejected here.
const TERMINAL_MEETING_STATUSES = new Set(['completed', 'cancelled', 'interrupted']);

fastify.patch('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { status, ended_at, summary, title, speaker_labels } = request.body || {};

  // Titles are a persisted user-facing name, not a free-form nullable patch.
  // Normalize once at the API boundary so browser-call and ordinary meetings
  // share the exact same contract and whitespace-only values never erase a
  // valid title. The UI validates too, but the authenticated write must remain
  // correct for stale clients and direct API callers.
  let normalizedTitle;
  if (title !== undefined) {
    try {
      normalizedTitle = normalizeMeetingTitle(title);
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: err.message });
    }
  }

  // Verify meeting exists and belongs to user (or admin)
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  // ── Live meeting sync (mobile → web), 2026-08-05 ──────────────────────────
  // Server-side enforcement of "only the originating device can end the
  // meeting" (Troy's explicit requirement — hiding the button client-side
  // is NOT sufficient on its own; a synced web session's devtools/Network
  // tab could otherwise fire this same PATCH directly). If this meeting has
  // a recorded owner_session_id (i.e. the owner-session-sync migration is
  // applied and this meeting was created after it), any request attempting
  // to move it into a TERMINAL status from a DIFFERENT session is rejected
  // — deliberately with NO admin bypass here (unlike the rep_id ownership
  // check just above), because the whole point of this rule is per-DEVICE
  // control, not per-account/per-role control; an admin viewing the same
  // synced dialog on a different device than the one that started the
  // meeting is exactly the scenario this is meant to block too. Non-
  // terminal edits (title, speaker_labels, summary, or ended_at without a
  // terminal status) are NOT gated by this check — those aren't "ending"
  // the meeting. If owner_session_id is NULL (pre-migration meeting, or
  // migration not yet applied to this DB), this check is a permissive
  // no-op — see migration file header for why that's safe.
  if (
    status !== undefined &&
    TERMINAL_MEETING_STATUSES.has(status) &&
    meeting.owner_session_id
  ) {
    const requestSessionId = request.cookies?.session_id || null;
    if (requestSessionId !== meeting.owner_session_id) {
      return reply.code(403).send({
        error: 'Only the device that started this meeting can end it.',
      });
    }
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
  if (ended_at !== undefined) { updates.push(`ended_at = $${idx++}`); values.push(ended_at); }
  if (summary !== undefined) { updates.push(`summary = $${idx++}`); values.push(summary); }
  if (title !== undefined) {
    updates.push(`title = $${idx++}`);
    values.push(normalizedTitle);
    // Manual title edit/override (2026-08-05 auto_titled follow-up): this
    // is the ONE existing path in this repo that writes `title` from a
    // client request body (the web PWA's "Add a title…" field, per
    // generateAutoTitleForMeeting()'s doc comment above). Any title set
    // through here is, by definition, no longer purely AI-generated —
    // clear `auto_titled` back to false in the SAME statement, even if
    // this row was previously auto-titled. (If a future auto-title re-run
    // ever fires again for this meeting, `generateAutoTitleForMeeting()`'s
    // own `WHERE title IS NULL OR title = ''` guard already prevents it
    // from clobbering this manual title, so this flag will correctly stay
    // false until/unless a title is cleared back to empty and re-auto-
    // generated.)
    updates.push(`auto_titled = false`);
  }
  let liveManualLabels = null;
  const manualTranscriptRelabels = [];
  if (speaker_labels !== undefined) {
    if (!speaker_labels || typeof speaker_labels !== 'object' || Array.isArray(speaker_labels)) {
      return reply.code(400).send({ error: 'speaker_labels must be an object' });
    }
    // Merge rather than replace: introduction lock events cause clients to
    // echo a PATCH, and concurrent echoes must not erase another proven key.
    // A different value is a true manual override and clears that slot's
    // introduction provenance; an identical echo preserves it.
    updates.push(`speaker_labels = COALESCE(speaker_labels, '{}'::jsonb) || $${idx++}::jsonb`);
    values.push(JSON.stringify(speaker_labels));
    liveManualLabels = {};
    const evidenceKeysToClear = [];
    for (const [speakerId, rawName] of Object.entries(speaker_labels)) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      const parsed = /^Speaker\s+(\d+)$/i.exec(speakerId);
      const evidenceKey = parsed ? String(parseInt(parsed[1], 10) - 1) : null;
      const isIntroductionEcho = Boolean(
        evidenceKey !== null &&
        meeting.speaker_label_evidence?.[evidenceKey]?.method === 'introduction' &&
        meeting.speaker_labels?.[speakerId] === name
      );
      if (!isIntroductionEcho) {
        liveManualLabels[speakerId] = name;
        if (evidenceKey !== null && meeting.speaker_label_evidence?.[evidenceKey]) {
          evidenceKeysToClear.push(evidenceKey);
          const previousName = String(meeting.speaker_labels?.[speakerId] || '').trim();
          if (previousName && previousName !== name) {
            manualTranscriptRelabels.push({ speakerId, from: previousName, to: name });
          }
        }
      }
    }
    if (evidenceKeysToClear.length > 0) {
      updates.push(`speaker_label_evidence = COALESCE(speaker_label_evidence, '{}'::jsonb) - $${idx++}::text[]`);
      values.push(evidenceKeysToClear);
    }
  }

  if (updates.length === 0) {
    return reply.code(400).send({ error: 'No fields to update' });
  }

  values.push(id);
  const result = await pool.query(
    `UPDATE meetings SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  // The ownership read above makes a zero-row update unexpected (the meeting
  // was deleted between SELECT and UPDATE). Never return a silent 200 with an
  // undefined body in that race; make the failed persistence visible.
  let updated;
  try {
    updated = requireSingleMeetingUpdate(result);
  } catch (err) {
    return reply.code(err.statusCode || 409).send({ error: err.message });
  }

  // Only seed the live manual lock after persistence succeeds. A failed
  // speaker-label PATCH must not leave an in-memory lock that survives for
  // the rest of the active meeting.
  if (liveManualLabels) {
    const liveController = activeMeetingSpeakerControllers.get(id);
    for (const { speakerId, from, to } of manualTranscriptRelabels) {
      // Introduction rows are stored with the resolved name so history/export
      // survive refresh. If a human corrects that name later, update those
      // rows too; otherwise the manual label would appear to save while old
      // history and exports continued showing the inferred name.
      await pool.query(
        `UPDATE transcript_segments SET speaker = $1 WHERE meeting_id = $2 AND speaker = $3`,
        [to, id, from]
      );
      broadcastToMeeting(id, { type: 'speaker_merge', from, to, source: 'manual_override' });
      broadcastToMeeting(id, { type: 'speaker_lock', speakerId, name: to, source: 'manual' });
    }
    if (liveController?.manualLock) {
      for (const [speakerId, name] of Object.entries(liveManualLabels)) {
        liveController.manualLock(speakerId, name);
      }
    }
  }

  // Live meeting sync: if this PATCH just finalized the meeting, tell any
  // connected observer sockets (the synced read-only dialog) and any other
  // logged-in session for this user (in case the observer hasn't opened the
  // meeting-specific sync socket yet, only the account-level one) so the UI
  // can reflect "meeting ended" and close/transition — see report for the
  // real WS test proving this fires.
  if (status !== undefined && TERMINAL_MEETING_STATUSES.has(status)) {
    broadcastToObservers(id, { type: 'meeting_ended', meetingId: id, status });
    notifyUserSyncMeetingEnded(meeting.rep_id, id);
    // Live rebuttal teleprompter (library-backed): drop this meeting's
    // cooldown/dismiss/concurrency state now that it's over — avoids an
    // unbounded Map growing for the life of the process across many
    // meetings. Safe no-op if this meeting never had any state (e.g. the
    // library was empty the whole call).
    clearMeetingPromptState(id);

    // Auto-title (origin-agnostic as of the 2026-08-05 follow-up pass) —
    // see generateAutoTitleForMeeting()'s doc comment for full scope/
    // reasoning/storage decision. Fires on THIS, the normal client-
    // initiated "End Meeting" finalize path (the other is
    // finalizeMeetingIfAbandoned() above, for crashed/dropped meetings
    // that never reach this PATCH). No `origin_client` gate anymore
    // (previously mobile-only) — fires for meetings started on either
    // platform. Still gated on:
    //   - `!title` (this request's OWN body) — if the SAME PATCH call that
    //     finalizes the meeting is also setting a manual title (e.g. a
    //     future client sending both at once), that explicit human choice
    //     wins and auto-title does not run at all, rather than racing to
    //     overwrite it. `generateAutoTitleForMeeting()`'s own UPDATE has a
    //     second `title IS NULL` guard for the remaining race window (a
    //     manual title PATCH landing between this finalize and this async
    //     call resolving).
    // Fire-and-forget, matches the existing runCoachingAnalysis() call-site
    // pattern below (auto-coaching) — never blocks/fails this response.
    if (!title) {
      generateAutoTitleForMeeting(id).catch((err) => {
        fastify.log.error(`generateAutoTitleForMeeting error (PATCH finalize path) for ${id}: ${err.message}`);
      });
    }
  }

  return shapeMeetingForClient(updated, request.cookies?.session_id || null);
});

// ─── Phase 3: Coaching analysis ──────────────────────────────────────────────

const COACHING_SYSTEM_PROMPT = `You are ARIA, a real-time sales coaching assistant for CertaPro Painters field reps.

You have deep knowledge of:
1. The CertaPro 10+1 Sales Process (Setup Call → Follow Up)
2. The 1st Go Around checklist (13 required items)
3. The DISC buyer personality framework (D/Eagle, I/Parrot, S/Dove, C/Owl)

Analyze the transcript and return a JSON coaching object ONLY — no prose, no markdown, just raw JSON.

Detect:
- The prospect's DISC style from their speech patterns, pace, word choices, and intonation descriptions
- Which sales stage the rep is currently in
- Which checklist items have been covered vs missed

FIELD GUIDANCE:
- disc.tip: Static one-liner on how to sell to this style (under 15 words). Example: "Lead with ROI, skip the story."
- nudges: 1-4 short action items for what the rep should do next (under 10 words each).
- urgent: DISC-based situational coaching — if you detect the rep made a misstep, missed a read on the prospect's style, or the conversation is drifting off track, write a brief recovery tip here (1-2 sentences max). Base it on what you know about this prospect's DISC style. Examples: "This Dove is pulling back — slow down and reassure before asking for price range." / "You over-explained to an Eagle — pivot to options and let them choose." / "The Owl asked for specifics you didn't answer — loop back and give the exact detail." Set to null if the conversation is on track and no correction is needed.

Return the exact JSON shape specified.`;

async function runCoachingAnalysis(meetingId) {
  if (!OPENROUTER_API_KEY) {
    return null;
  }

  // Fetch last 20 final transcript segments
  let segments;
  try {
    const segResult = await pool.query(
      `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts DESC LIMIT 20`,
      [meetingId]
    );
    segments = segResult.rows.reverse();
  } catch (err) {
    console.error('coaching: DB error fetching segments:', err.message);
    return null;
  }

  if (segments.length < 3) return null;

  const transcriptText = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

  const systemWithKB = `${COACHING_SYSTEM_PROMPT}\n\n=== DISC FRAMEWORK ===\n${kbDiscFramework}\n\n=== 10+1 SALES PROCESS ===\n${kb10Plus1Process}\n\n=== 1ST GO AROUND CHECKLIST ===\n${kbFirstGoAround}`;

  const userPrompt = `Meeting transcript (last ${segments.length} segments):\n\n${transcriptText}\n\nReturn ONLY raw JSON with this exact shape:\n{
  "disc": {
    "detected": "D",
    "confidence": "medium",
    "emoji": "🦅",
    "label": "Dominant (Eagle)",
    "tip": "Be direct, lead with outcomes"
  },
  "stage": {
    "current": "first_go_around",
    "label": "1st Go Around"
  },
  "checklist": [
    { "id": "scope", "label": "Confirm scope", "done": false },
    { "id": "why_now", "label": "Why now / motivation", "done": false },
    { "id": "colors", "label": "Color per area", "done": false },
    { "id": "primer_coats", "label": "Primer & coats", "done": false },
    { "id": "setup_prep", "label": "Setup & prep costs", "done": false },
    { "id": "carpentry", "label": "Carpentry / repairs", "done": false },
    { "id": "four_stages", "label": "4 stages of paint job", "done": false },
    { "id": "certainty_pledge", "label": "Certainty Pledge®", "done": false },
    { "id": "price_range", "label": "Price range", "done": false },
    { "id": "options", "label": "Options discussed", "done": false },
    { "id": "photos", "label": "Photo permission", "done": false }
  ],
  "nudges": ["Ask: why now?"],
  "urgent": null
}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aria.certaprograndhaven.com',
        'X-Title': 'ARIA Sales Helper',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemWithKB },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error('coaching: empty response from Claude');
      return null;
    }

    // Parse JSON — Claude may wrap in ```json fences
    let coaching;
    try {
      coaching = JSON.parse(rawContent);
    } catch {
      // Strip markdown fences and try again
      const stripped = rawContent.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      try {
        coaching = JSON.parse(stripped);
      } catch {
        // Extract first {...} block and repair common issues (trailing commas)
        const jsonMatch = stripped.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const repaired = jsonMatch[0]
              .replace(/,\s*([}\]])/g, '$1')  // trailing commas
              .replace(/([{,]\s*)(\w+):/g, '$1"$2":'); // unquoted keys
            coaching = JSON.parse(repaired);
          } catch {
            console.error('coaching: could not parse JSON from Claude response');
            return null;
          }
        } else {
          console.error('coaching: no JSON object found in Claude response');
          return null;
        }
      }
    }

    // Normalize: urgent must be string | null (Claude sometimes returns an object)
    if (coaching.urgent && typeof coaching.urgent === 'object') {
      coaching.urgent = coaching.urgent.message || coaching.urgent.flag || JSON.stringify(coaching.urgent);
    }

    // Persist snapshot
    try {
      await pool.query(
        `INSERT INTO coaching_snapshots (meeting_id, snapshot) VALUES ($1, $2)`,
        [meetingId, JSON.stringify(coaching)]
      );
    } catch (dbErr) {
      console.error('coaching: failed to save snapshot:', dbErr.message);
    }

    return coaching;
  } catch (err) {
    console.error('coaching: fetch/parse error:', err.message);
    return null;
  }
}

// GET /api/meetings/:id/coaching/latest — fetch latest coaching snapshot with merged sticky checklist
fastify.get('/api/meetings/:id/coaching/latest', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  if (!hasAdminAccess(request.user.role) && existing.rows[0].rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  // Get all snapshots and merge checklist — once done always done
  const result = await pool.query(
    `SELECT snapshot FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  if (result.rows.length === 0) return { coaching: null };

  // Start from latest snapshot, then OR in all previously-checked items
  const latest = result.rows[result.rows.length - 1].snapshot;
  const checkedIds = new Set();
  for (const row of result.rows) {
    for (const item of row.snapshot.checklist || []) {
      if (item.done) checkedIds.add(item.id);
    }
  }
  const merged = (latest.checklist || []).map(item => ({
    ...item,
    done: item.done || checkedIds.has(item.id),
  }));
  return { coaching: { ...latest, checklist: merged } };
});

// POST /api/meetings/:id/coaching — manual trigger
fastify.post('/api/meetings/:id/coaching', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const coaching = await runCoachingAnalysis(id);
  if (!coaching) {
    return reply.code(503).send({ error: 'Coaching unavailable — not enough transcript or missing API key' });
  }

  return coaching;
});

// ─── Post-meeting analytics: WPM, checklist sequencing/timing, Meeting Score ──
// GET /api/meetings/:id/analytics
// Computed entirely from data already captured (Deepgram word timestamps
// stored per transcript_segment + the coaching_snapshots history) — no new
// vendor/infra required.

const CHECKLIST_IDEAL_ORDER = [
  'scope', 'why_now', 'colors', 'primer_coats', 'setup_prep', 'carpentry',
  'four_stages', 'certainty_pledge', 'price_range', 'options', 'photos',
];
const WPM_IDEAL_MIN = 120;
const WPM_IDEAL_MAX = 160;
const CRITICAL_CHECKLIST_ITEMS = ['scope', 'price_range'];
const LATE_CRITICAL_THRESHOLD = 0.7; // flag if hit past 70% of meeting duration

// Longest-increasing-subsequence ratio: what fraction of the rep's actually-
// hit checklist items appear in an order consistent with the ideal sequence.
// 1.0 = perfectly ordered, lower = more items covered out of sequence.
function sequenceMatchRatio(actualOrderIds, idealOrderIds) {
  if (actualOrderIds.length === 0) return 1;
  const idealIndex = new Map(idealOrderIds.map((id, i) => [id, i]));
  const indices = actualOrderIds.map(id => idealIndex.get(id)).filter(i => i !== undefined);
  if (indices.length === 0) return 0;
  const tails = [];
  for (const num of indices) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < num) lo = mid + 1; else hi = mid;
    }
    if (lo === tails.length) tails.push(num); else tails[lo] = num;
  }
  return tails.length / indices.length;
}

// Extracted 2026-08-05 (ARIA Priority 1 roadmap, item 6 — coaching reports)
// so both the /analytics route AND the new /coaching-report route can share
// the exact same computation instead of duplicating ~150 lines of scoring
// logic. Behavior is unchanged — this is a pure refactor, not a rewrite.
async function computeMeetingAnalytics(id, meeting) {
  const repResult = await pool.query('SELECT name FROM users WHERE id = $1', [meeting.rep_id]);
  const repName = repResult.rows[0]?.name || null;

  const segResult = await pool.query(
    `SELECT speaker, text, ts, word_count, duration_ms FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;

  const meetingStart = meeting.started_at
    ? new Date(meeting.started_at).getTime()
    : (segments[0] ? new Date(segments[0].ts).getTime() : Date.now());
  const meetingEnd = meeting.ended_at
    ? new Date(meeting.ended_at).getTime()
    : (segments.length ? new Date(segments[segments.length - 1].ts).getTime() : Date.now());
  const meetingDurationMin = Math.max(1, (meetingEnd - meetingStart) / 60000);

  // ── Word cadence / WPM ────────────────────────────────────────────────────
  // Only counts segments attributed to the rep's resolved display name, and
  // only segments with real Deepgram word timing (duration_ms populated) —
  // the pre-migration/fallback rows without timing are silently excluded
  // rather than skewing the average.
  const repSegments = segments.filter(s => repName && s.speaker === repName);
  let totalRepWords = 0;
  let totalRepDurationMs = 0;
  const wpmBuckets = new Map(); // minute-of-call -> { words, durationMs }
  for (const seg of repSegments) {
    if (!seg.word_count || !seg.duration_ms || seg.duration_ms <= 0) continue;
    totalRepWords += seg.word_count;
    totalRepDurationMs += seg.duration_ms;
    const minuteBucket = Math.max(0, Math.floor((new Date(seg.ts).getTime() - meetingStart) / 60000));
    const bucket = wpmBuckets.get(minuteBucket) || { words: 0, durationMs: 0 };
    bucket.words += seg.word_count;
    bucket.durationMs += seg.duration_ms;
    wpmBuckets.set(minuteBucket, bucket);
  }
  const avgWpm = totalRepDurationMs > 0
    ? Math.round((totalRepWords / (totalRepDurationMs / 1000)) * 60)
    : null;
  const wpmOverTime = Array.from(wpmBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([minute, b]) => ({
      minute,
      wpm: b.durationMs > 0 ? Math.round((b.words / (b.durationMs / 1000)) * 60) : null,
    }))
    .filter(p => p.wpm !== null);

  let paceFlag = null;
  if (avgWpm !== null) {
    paceFlag = avgWpm < WPM_IDEAL_MIN ? 'slow' : avgWpm > WPM_IDEAL_MAX ? 'fast' : 'good';
  }

  // ── Checklist sequencing / timing ─────────────────────────────────────────
  // "When", not just "if": walk the full coaching-snapshot history (already
  // persisted every ~3 segments during the live call) and find the earliest
  // snapshot where each item flipped to done.
  const snapResult = await pool.query(
    `SELECT snapshot, created_at FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at ASC`,
    [id]
  );
  const snapshots = snapResult.rows;

  const firstHitAt = {}; // item id -> Date it first showed done=true
  for (const row of snapshots) {
    for (const item of row.snapshot?.checklist || []) {
      if (item.done && firstHitAt[item.id] === undefined) firstHitAt[item.id] = row.created_at;
    }
  }

  const latestChecklist = snapshots.length > 0 ? (snapshots[snapshots.length - 1].snapshot?.checklist || []) : [];
  const checklistTiming = CHECKLIST_IDEAL_ORDER.map(itemId => {
    const hitAt = firstHitAt[itemId];
    const labelRow = latestChecklist.find(i => i.id === itemId);
    return {
      id: itemId,
      label: labelRow?.label || itemId,
      hit: hitAt !== undefined,
      minutesIn: hitAt !== undefined ? Math.round((new Date(hitAt).getTime() - meetingStart) / 60000) : null,
    };
  });

  const actualOrderIds = checklistTiming
    .filter(c => c.hit)
    .sort((a, b) => (a.minutesIn ?? 0) - (b.minutesIn ?? 0))
    .map(c => c.id);
  const sequenceScoreRatio = sequenceMatchRatio(actualOrderIds, CHECKLIST_IDEAL_ORDER);

  const lateCriticalItems = checklistTiming
    .filter(c => CRITICAL_CHECKLIST_ITEMS.includes(c.id) && c.hit && c.minutesIn !== null)
    .filter(c => (c.minutesIn / meetingDurationMin) > LATE_CRITICAL_THRESHOLD)
    .map(c => ({ id: c.id, label: c.label, minutesIn: c.minutesIn }));

  const coveredCount = checklistTiming.filter(c => c.hit).length;
  const coveragePct = Math.round((coveredCount / CHECKLIST_IDEAL_ORDER.length) * 100);

  // ── DISC adaptation quality ────────────────────────────────────────────────
  // Approximated from how often the coaching engine had to raise an "urgent"
  // situational correction — fewer corrections needed across the call implies
  // better real-time adaptation to the prospect's detected style.
  const urgentCount = snapshots.filter(row => row.snapshot?.urgent).length;
  const discAdaptationScore = snapshots.length > 0
    ? Math.round(Math.max(0, 1 - (urgentCount / snapshots.length)) * 100)
    : null;

  // ── Composite Meeting Score card ──────────────────────────────────────────
  const paceScore = paceFlag === null ? null : (paceFlag === 'good' ? 100 : 60);
  const scoreComponents = [
    { key: 'coverage', label: 'Checklist Coverage', value: coveragePct, weight: 0.35 },
    { key: 'sequencing', label: 'Sequence Order', value: Math.round(sequenceScoreRatio * 100), weight: 0.25 },
    { key: 'pacing', label: 'Speaking Pace', value: paceScore, weight: 0.20 },
    { key: 'disc_adaptation', label: 'DISC Adaptation', value: discAdaptationScore, weight: 0.20 },
  ].filter(c => c.value !== null);

  const totalWeight = scoreComponents.reduce((s, c) => s + c.weight, 0);
  const meetingScore = totalWeight > 0
    ? Math.round(scoreComponents.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight)
    : null;

  return {
    repName,
    wpm: {
      avg: avgWpm,
      idealMin: WPM_IDEAL_MIN,
      idealMax: WPM_IDEAL_MAX,
      paceFlag,
      overTime: wpmOverTime,
    },
    checklistTiming,
    sequencing: {
      score: Math.round(sequenceScoreRatio * 100),
      actualOrder: actualOrderIds,
      idealOrder: CHECKLIST_IDEAL_ORDER,
      lateCriticalItems,
    },
    coveragePct,
    discAdaptationScore,
    meetingScore,
    scoreComponents,
  };
}

fastify.get('/api/meetings/:id/analytics', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const analytics = await computeMeetingAnalytics(id, meeting);
  return analytics;
});

// ─── ARIA Priority 1 roadmap (2026-08-05) ───────────────────────────────────
// Items 1 (BANT + closing certainty), 3 (insider-language flagger),
// 4 (question-listening gaps), 6 (coaching report aggregation).
// Item 2 (TEPIT) intentionally skipped — not defined, per task scope.
// All LLM analysis routed through coachingAnalysis.js, which reuses the
// SAME Claude-via-OpenRouter pipeline as the existing coaching/summary
// endpoints above (no new AI provider).
//
// NOTE ON SCHEMA: bant_scores / insider_language_flags / question_gaps are
// NEW tables defined in migrations/2026-08-05-coaching-analysis-tables.sql.
// That migration has NOT been applied to production (see migration file
// header + this task's final report) — these routes will 500 with a clear
// "relation does not exist" Postgres error until someone applies it. This
// mirrors the exact same not-yet-applied pattern as the 2026-08-04
// pyannoteAI/Twilio migrations already sitting in this same directory.

// POST /api/meetings/:id/bant — run/re-run BANT + closing-certainty analysis
fastify.post('/api/meetings/:id/bant', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  if (!OPENROUTER_API_KEY) {
    return reply.code(503).send({ error: 'BANT analysis requires OPENROUTER_API_KEY.' });
  }

  const segResult = await pool.query(
    `SELECT speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const bant = await analyzeBant(OPENROUTER_API_KEY, id, segResult.rows);
  if (!bant) {
    return reply.code(503).send({ error: 'BANT analysis unavailable — not enough transcript or LLM error' });
  }

  try {
    const upserted = await pool.query(
      `INSERT INTO bant_scores
         (meeting_id, budget_score, authority_score, need_score, timeline_score, closing_certainty_pct, rationale, model, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (meeting_id) DO UPDATE SET
         budget_score = $2, authority_score = $3, need_score = $4, timeline_score = $5,
         closing_certainty_pct = $6, rationale = $7, model = $8, updated_at = NOW()
       RETURNING *`,
      [
        id,
        bant.budget.score, bant.authority.score, bant.need.score, bant.timeline.score,
        bant.closing_certainty_pct,
        JSON.stringify({
          budget: bant.budget.rationale,
          authority: bant.authority.rationale,
          need: bant.need.rationale,
          timeline: bant.timeline.rationale,
          overall: bant.overall_rationale,
        }),
        'anthropic/claude-haiku-4-5',
      ]
    );
    return upserted.rows[0];
  } catch (dbErr) {
    fastify.log.error('bant_scores upsert error:', dbErr);
    return reply.code(502).send({ error: 'BANT analysis computed but failed to persist: ' + dbErr.message });
  }
});

// GET /api/meetings/:id/bant — fetch the stored BANT result (if any)
fastify.get('/api/meetings/:id/bant', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const result = await pool.query('SELECT * FROM bant_scores WHERE meeting_id = $1', [id]);
  if (result.rows.length === 0) return { bant: null };
  return { bant: result.rows[0] };
});

// POST /api/meetings/:id/insider-language — run/re-run insider-language flagging
fastify.post('/api/meetings/:id/insider-language', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  if (!OPENROUTER_API_KEY) {
    return reply.code(503).send({ error: 'Insider-language analysis requires OPENROUTER_API_KEY.' });
  }

  const segResult = await pool.query(
    `SELECT speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;
  const flags = await analyzeInsiderLanguage(OPENROUTER_API_KEY, id, segments);
  if (flags === null) {
    return reply.code(503).send({ error: 'Insider-language analysis failed (LLM error)' });
  }

  try {
    await pool.query('DELETE FROM insider_language_flags WHERE meeting_id = $1', [id]);
    const inserted = [];
    for (const f of flags) {
      const seg = segments[f.segment_index];
      const minutesIn = seg && meeting.started_at
        ? (new Date(seg.ts).getTime() - new Date(meeting.started_at).getTime()) / 60000
        : null;
      const row = await pool.query(
        `INSERT INTO insider_language_flags (meeting_id, segment_index, ts, minutes_in, phrase, explanation)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, f.segment_index, seg?.ts || null, minutesIn, f.phrase, f.explanation]
      );
      inserted.push(row.rows[0]);
    }
    return { flags: inserted };
  } catch (dbErr) {
    fastify.log.error('insider_language_flags persist error:', dbErr);
    return reply.code(502).send({ error: 'Insider-language analysis computed but failed to persist: ' + dbErr.message });
  }
});

// GET /api/meetings/:id/insider-language — fetch stored flags
fastify.get('/api/meetings/:id/insider-language', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const result = await pool.query(
    'SELECT * FROM insider_language_flags WHERE meeting_id = $1 ORDER BY ts ASC NULLS LAST',
    [id]
  );
  return { flags: result.rows };
});

// POST /api/meetings/:id/question-gaps — run/re-run question-gap detection
fastify.post('/api/meetings/:id/question-gaps', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  if (!OPENROUTER_API_KEY) {
    return reply.code(503).send({ error: 'Question-gap analysis requires OPENROUTER_API_KEY.' });
  }

  const segResult = await pool.query(
    `SELECT speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;
  const gaps = await analyzeQuestionGaps(OPENROUTER_API_KEY, id, segments);
  if (gaps === null) {
    return reply.code(503).send({ error: 'Question-gap analysis failed (LLM error)' });
  }

  try {
    await pool.query('DELETE FROM question_gaps WHERE meeting_id = $1', [id]);
    const inserted = [];
    for (const g of gaps) {
      const seg = segments[g.question_segment_index];
      const minutesIn = seg && meeting.started_at
        ? (new Date(seg.ts).getTime() - new Date(meeting.started_at).getTime()) / 60000
        : null;
      const row = await pool.query(
        `INSERT INTO question_gaps (meeting_id, question_segment_index, question_text, question_ts, question_minutes_in, rep_response_excerpt, explanation)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, g.question_segment_index, g.question_text, seg?.ts || null, minutesIn, g.rep_response_excerpt, g.explanation]
      );
      inserted.push(row.rows[0]);
    }
    return { gaps: inserted };
  } catch (dbErr) {
    fastify.log.error('question_gaps persist error:', dbErr);
    return reply.code(502).send({ error: 'Question-gap analysis computed but failed to persist: ' + dbErr.message });
  }
});

// GET /api/meetings/:id/question-gaps — fetch stored gaps
fastify.get('/api/meetings/:id/question-gaps', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const result = await pool.query(
    'SELECT * FROM question_gaps WHERE meeting_id = $1 ORDER BY question_ts ASC NULLS LAST',
    [id]
  );
  return { gaps: result.rows };
});

// GET /api/meetings/:id/coaching-report — Item 6: manager-facing aggregate
// report combining BANT (#1), insider-language flags (#3), question gaps
// (#4), and existing coaching metrics (checklist coverage/sequencing, WPM
// pacing, DISC adaptation from computeMeetingAnalytics()). Read-only —
// does NOT trigger new LLM analysis; run the individual POST endpoints
// above first (or let a future "generate full report" button chain them).
fastify.get('/api/meetings/:id/coaching-report', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query(
    `SELECT m.*, u.name as rep_name, c.name as customer_name
     FROM meetings m
     LEFT JOIN users u ON m.rep_id = u.id
     LEFT JOIN customers c ON m.customer_id = c.id
     WHERE m.id = $1`,
    [id]
  );
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const [bantResult, insiderResult, gapsResult, analytics] = await Promise.all([
    pool.query('SELECT * FROM bant_scores WHERE meeting_id = $1', [id]),
    pool.query('SELECT * FROM insider_language_flags WHERE meeting_id = $1 ORDER BY ts ASC NULLS LAST', [id]),
    pool.query('SELECT * FROM question_gaps WHERE meeting_id = $1 ORDER BY question_ts ASC NULLS LAST', [id]),
    computeMeetingAnalytics(id, meeting),
  ]);

  return {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      customer_name: meeting.customer_name,
      rep_name: meeting.rep_name,
      started_at: meeting.started_at,
      ended_at: meeting.ended_at,
      status: meeting.status,
    },
    bant: bantResult.rows[0] || null,
    insiderLanguageFlags: insiderResult.rows,
    questionGaps: gapsResult.rows,
    meetingScore: analytics.meetingScore,
    scoreComponents: analytics.scoreComponents,
    coveragePct: analytics.coveragePct,
    wpm: analytics.wpm,
    discAdaptationScore: analytics.discAdaptationScore,
  };
});

// ─── Phase 2: Consent endpoint ────────────────────────────────────────────────
// DELETE /api/meetings/:id
fastify.delete('/api/meetings/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  await pool.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [id]);
  await pool.query('DELETE FROM coaching_snapshots WHERE meeting_id = $1', [id]);
  await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
  return { ok: true };
});

// GET /api/meetings/:id/segments — fetch saved transcript segments
fastify.get('/api/meetings/:id/segments', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const existing = await pool.query('SELECT rep_id FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) return reply.code(404).send({ error: 'Meeting not found' });
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const result = await pool.query(
    `SELECT id, speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  return { segments: result.rows };
});

// POST /api/meetings/:id/consent — log consent confirmation

fastify.post('/api/meetings/:id/consent', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  // Verify meeting exists and belongs to user (or admin)
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const result = await pool.query(
    `UPDATE meetings SET consent_confirmed_at = NOW() WHERE id = $1 RETURNING consent_confirmed_at`,
    [id]
  );

  return { ok: true, consent_confirmed_at: result.rows[0].consent_confirmed_at };
});

// ─── Live rebuttal teleprompter: dismiss a library-matched prompt ──────────
// POST /api/meetings/:id/dismiss-rebuttal
// The rep's dismiss tap on a `suggested_rebuttal_library` prompt. Records
// the dismissal in objectionLibraryMatcher.js's per-meeting state so the
// SAME objection never re-fires for the rest of this meeting ("dismissing
// must stick for that meeting", per this task's explicit requirement) even
// across a socket reconnect (state is keyed by meetingId, not by socket).
// Broadcasts `suggested_rebuttal_library_dismiss` so any other synced
// client watching this meeting (e.g. an observer view) also closes the
// prompt — same broadcastToMeeting()-reaches-owner-and-observers pattern
// used by every other live message type in this file.
fastify.post('/api/meetings/:id/dismiss-rebuttal', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { objectionId } = request.body || {};

  if (!objectionId) {
    return reply.code(400).send({ error: 'objectionId is required' });
  }

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  markPromptDismissed(id, objectionId);
  broadcastToMeeting(id, { type: 'suggested_rebuttal_library_dismiss', objectionId });

  return { ok: true };
});

// ─── Speaker-lock confirm/reject (2026-08-10, intro-window fix) ──────────────
// POST /api/meetings/:id/speaker-lock
// Client -> server half of the mid-call name-introduction confirmation flow.
// The server first emits a `speaker_lock_suggestion` WS message ("We think
// Speaker 2 is John — is that right?"); the user answers via this route:
//   body { speakerId: "Speaker 2", action: "confirm", name: "John" }
//     -> commits the lock (via the live speaker controller) and the server
//        broadcasts the existing `speaker_lock` message so every synced
//        client relabels. `name` may be an EDITED value (Yes/Edit UI).
//   body { speakerId: "Speaker 2", action: "reject", name: "John" }
//     -> records the rejection so the detector won't re-suggest that name and
//        keeps listening for a better candidate (does NOT give up on the slot).
// Auth: same owner/admin check as every other meeting route. A web observer
// watching a mobile-originated meeting is the SAME user_id as the owner, so it
// passes this check and can confirm from the synced view too.
fastify.post('/api/meetings/:id/speaker-lock', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { speakerId, action, name } = request.body || {};

  if (!speakerId || (action !== 'confirm' && action !== 'reject')) {
    return reply.code(400).send({ error: 'speakerId and action ("confirm"|"reject") are required' });
  }
  if (action === 'confirm' && (!name || !String(name).trim())) {
    return reply.code(400).send({ error: 'name is required to confirm' });
  }

  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }
  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  const controller = activeMeetingSpeakerControllers.get(id);
  if (!controller) {
    // No live audio connection (meeting ended, or between reconnects). We can
    // still honor a CONFIRM by broadcasting the lock so any open client view
    // relabels; there's no live speakerLocks state to keep in sync anymore.
    // A REJECT with no live detector is a no-op ack (nothing left listening).
    if (action === 'confirm') {
      const display = String(name).trim();
      broadcastToMeeting(id, { type: 'speaker_lock', speakerId, name: display });
      return { ok: true, committed: true, live: false, name: display };
    }
    return { ok: true, committed: false, live: false };
  }

  const res = action === 'confirm'
    ? controller.confirm(speakerId, name)
    : controller.reject(speakerId, name);

  if (!res.ok) return reply.code(400).send({ error: res.error || 'speaker-lock action failed' });
  return { ok: true, live: true, action, ...res };
});

// ─── Phase 2: Summary endpoint ────────────────────────────────────────────────
// POST /api/meetings/:id/summary — generate + store AI summary

fastify.post('/api/meetings/:id/summary', { preHandler: [requireAuth], config: { rawBody: false } }, async (request, reply) => {
  const { id } = request.params;

  // Verify meeting
  const existing = await pool.query('SELECT * FROM meetings WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  // Fetch transcript
  const segResult = await pool.query(
    `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );

  const segments = segResult.rows;
  let transcriptText = '';

  if (segments.length === 0) {
    transcriptText = '(No transcript recorded)';
  } else {
    transcriptText = segments
      .map(s => `${s.speaker}: ${s.text}`)
      .join('\n');
  }

  let summaryText;

  // Also pull the latest coaching snapshot to know which checklist items were hit
  const coachingResult = await pool.query(
    `SELECT snapshot FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id]
  );
  const lastCoaching = coachingResult.rows[0]?.snapshot || null;
  const checklist = lastCoaching?.checklist || [];
  const hitItems = checklist.filter(i => i.done).map(i => i.label);
  const missedItems = checklist.filter(i => !i.done).map(i => i.label);
  const detectedStage = lastCoaching?.stage?.label || 'Unknown';

  const SUMMARY_SYSTEM = `You are ARIA, a sales coach for CertaPro Painters field reps.
You have deep knowledge of:
1. The CertaPro 10+1 Sales Process (11 stages: Setup Call, Arrival, Upfront 4, 1st Go Around, Client Manual, 2nd Go Around, Rough Estimate, Prepare Proposal, Proposal Presentation, Ask for the Order, Follow Up)
2. The 1st Go Around checklist (11 required items the rep must cover)

=== 10+1 SALES PROCESS ===
${kb10Plus1Process}

=== 1ST GO AROUND CHECKLIST ===
${kbFirstGoAround}`;

  const checklistContext = checklist.length > 0
    ? `\n\nChecklist items COVERED during this meeting: ${hitItems.length > 0 ? hitItems.join(', ') : 'None detected'}\nChecklist items MISSED: ${missedItems.length > 0 ? missedItems.join(', ') : 'None — all covered'}\nLast detected sales stage: ${detectedStage}`
    : '';

  const SUMMARY_USER = `Meeting transcript:\n\n${transcriptText}${checklistContext}\n\nWrite a structured meeting summary with these sections (plain text, no markdown asterisks or symbols):\n\n1. MEETING OVERVIEW\nBrief 2-3 sentence summary of what was discussed.\n\n2. SALES STAGE\nWhich of the 11 sales stages was reached and how far the rep got through the process.\n\n3. CHECKLIST COVERAGE\nList each 1st Go Around checklist item and whether it was covered or missed. Be specific about what was said or skipped.\n\n4. WHAT WAS MISSED\nClearly call out any checklist items or required sales stages the rep did not complete, and why it matters.\n\n5. ACTION ITEMS\n3-5 concrete next steps for the rep to follow up on.`;

  if (anthropicPrimaryText.availability.textGeneration === 'missing') {
    summaryText = '⚠️ Summary generation requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY. Please provision a key and try again.\n\n' +
      `Transcript preview (first 500 chars):\n${transcriptText.slice(0, 500)}`;
  } else {
    try {
      const generated = await anthropicPrimaryText.generate({
        model: 'claude-haiku-4-5',
        maxTokens: 1500,
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: SUMMARY_USER }],
      });
      summaryText = generated.text;
    } catch (err) {
      fastify.log.error(`summary generation failed for ${id} (${formatAiFailure(err)})`);
      return reply.code(502).send({ error: 'Summary generation failed' });
    }
  }

  // Persist summary
  await pool.query(
    `UPDATE meetings SET summary = $1 WHERE id = $2`,
    [summaryText, id]
  );

  return { summary: summaryText };
});

// Extract just the "ACTION ITEMS" section out of a generated summary text.
// Mirrors the frontend's extractActionItems() in MeetingPage.tsx so the
// exported Google Doc's action-items section matches what reps already see.
function extractActionItemsServer(summaryText) {
  if (!summaryText) return null;
  const lines = summaryText.split('\n');
  const startIdx = lines.findIndex(l => /action items/i.test(l));
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex(l => /^\s*\d+\.\s+[A-Z]/.test(l));
  const body = (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n').trim();
  return body || null;
}

// POST /api/meetings/:id/export-to-docs — create a Google Doc with the
// meeting's summary/action items/transcript and share it with the requesting
// user's real email address.
fastify.post('/api/meetings/:id/export-to-docs', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;

  const existing = await pool.query(
    `SELECT m.*, c.name as customer_name
     FROM meetings m
     LEFT JOIN customers c ON m.customer_id = c.id
     WHERE m.id = $1`,
    [id]
  );
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Meeting not found' });
  }

  const meeting = existing.rows[0];
  if (!hasAdminAccess(request.user.role) && meeting.rep_id !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return reply.code(503).send({ error: 'Google Docs export is not configured (missing GOOGLE_SERVICE_ACCOUNT_JSON).' });
  }

  const userEmail = request.user.email;
  if (!userEmail) {
    return reply.code(400).send({ error: 'Your account has no email on file — cannot share the doc.' });
  }

  // Fetch transcript (same query pattern as the /summary endpoint)
  const segResult = await pool.query(
    `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [id]
  );
  const segments = segResult.rows;
  const transcriptText = segments.length === 0
    ? '(No transcript recorded)'
    : segments.map(s => `${s.speaker}: ${s.text}`).join('\n');

  const summaryText = meeting.summary || '(No summary generated yet)';
  const actionItems = extractActionItemsServer(meeting.summary || '');

  const displayTitle = meeting.title || meeting.customer_name || 'Meeting';
  const meetingDate = new Date(meeting.started_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const docTitle = `${displayTitle} — ${meetingDate}`;

  const contentLines = [];
  contentLines.push(docTitle);
  if (meeting.customer_name) contentLines.push(`Customer: ${meeting.customer_name}`);
  contentLines.push(`Date: ${meetingDate}`);
  contentLines.push('');
  contentLines.push('SUMMARY');
  contentLines.push('─'.repeat(40));
  contentLines.push(summaryText.replace(/\*/g, ''));
  contentLines.push('');
  if (actionItems) {
    contentLines.push('ACTION ITEMS');
    contentLines.push('─'.repeat(40));
    contentLines.push(actionItems);
    contentLines.push('');
  }
  contentLines.push('TRANSCRIPT');
  contentLines.push('─'.repeat(40));
  contentLines.push(transcriptText);
  contentLines.push('');
  contentLines.push('Generated by ARIA — CertaPro Grand Haven');

  const content = contentLines.join('\n');

  try {
    const { docId, webViewLink } = await createMeetingDoc(docTitle, content, userEmail);
    return { docId, webViewLink };
  } catch (err) {
    fastify.log.error('export-to-docs error:', err);
    return reply.code(502).send({ error: 'Failed to create Google Doc: ' + err.message });
  }
});

// ─── Customer routes ──────────────────────────────────────────────────────────

fastify.post('/api/customers', { preHandler: [requireAuth] }, async (request, reply) => {
  const { name, address, phone, email, source } = request.body || {};

  if (!name) {
    return reply.code(400).send({ error: 'name is required' });
  }

  const result = await pool.query(
    `INSERT INTO customers (name, address, phone, email, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, address || null, phone || null, email || null, source || null, request.user.id]
  );

  return reply.code(201).send(result.rows[0]);
});

fastify.get('/api/customers', { preHandler: [requireAuth] }, async (request, reply) => {
  const { role, id } = request.user;
  let result;

  if (hasAdminAccess(role)) {
    result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
  } else {
    result = await pool.query(
      'SELECT * FROM customers WHERE created_by = $1 ORDER BY created_at DESC',
      [id]
    );
  }

  return result.rows;
});

fastify.get('/api/customers/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Customer not found' });
  }

  const customer = result.rows[0];
  if (!hasAdminAccess(request.user.role) && customer.created_by !== request.user.id) {
    return reply.code(403).send({ error: 'Forbidden' });
  }

  return customer;
});

// ─── Objections / Rebuttals library ──────────────────────────────────────────
// Added 2026-08-18, Troy Hacker's request (business owner, end user —
// tracked as the "Rebuttal list to objections" line in HighPriorityTodos).
// A standalone reference library: reps browse a shared list of customer
// objections, each holding one or more rebuttals other reps have found
// effective. Deliberately NOT wired into the live meeting/coaching pipeline
// (that's objectionDetection.js / coachingAnalysis.js's generateRebuttal(),
// an unrelated in-call stub) — this is a standalone aria-web tab only, per
// the task's explicit scope.
//
// Auth model: unlike /api/customers (scoped to created_by — each rep's own
// leads), objections/rebuttals are a SHARED team knowledge base — the
// entire point is pooling field-tested rebuttals across the whole sales
// team, so every route below is visible to and writable by ANY
// authenticated rep, not just admins and not just the row's own creator.
// This is an explicit product choice, not an oversight — flagged in this
// task's report for Gabe to overrule if he'd rather creation/editing be
// admin-gated.
//
// ⚠️ Requires migrations/2026-08-18-objections-rebuttals.sql to have been
// applied by hand against the DB first (this repo's migrations are NOT
// auto-run on deploy) — every route below will 500 with a "relation
// \"objections\" does not exist" error until that migration is run.

fastify.post('/api/objections', { preHandler: [requireAuth] }, async (request, reply) => {
  const { text, category } = request.body || {};

  if (!text || !String(text).trim()) {
    return reply.code(400).send({ error: 'text is required' });
  }

  const result = await pool.query(
    `INSERT INTO objections (text, category, created_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [String(text).trim(), category ? String(category).trim() : null, request.user.id]
  );

  return reply.code(201).send(result.rows[0]);
});

fastify.get('/api/objections', { preHandler: [requireAuth] }, async (request, reply) => {
  // Shared library — every authenticated rep sees every objection,
  // regardless of who created it (see auth-model comment above).
  const result = await pool.query(
    `SELECT o.*,
            COALESCE(r.rebuttal_count, 0) AS rebuttal_count
     FROM objections o
     LEFT JOIN (
       SELECT objection_id, COUNT(*)::int AS rebuttal_count
       FROM rebuttals
       GROUP BY objection_id
     ) r ON r.objection_id = o.id
     ORDER BY o.created_at DESC`
  );
  return result.rows;
});

fastify.get('/api/objections/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const objResult = await pool.query('SELECT * FROM objections WHERE id = $1', [id]);

  if (objResult.rows.length === 0) {
    return reply.code(404).send({ error: 'Objection not found' });
  }

  const rebuttalsResult = await pool.query(
    'SELECT * FROM rebuttals WHERE objection_id = $1 ORDER BY created_at ASC',
    [id]
  );

  return { ...objResult.rows[0], rebuttals: rebuttalsResult.rows };
});

fastify.patch('/api/objections/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { text, category } = request.body || {};

  const existing = await pool.query('SELECT * FROM objections WHERE id = $1', [id]);
  if (existing.rows.length === 0) {
    return reply.code(404).send({ error: 'Objection not found' });
  }

  if (text !== undefined && !String(text).trim()) {
    return reply.code(400).send({ error: 'text cannot be empty' });
  }

  const result = await pool.query(
    `UPDATE objections
     SET text = COALESCE($1, text),
         category = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [
      text !== undefined ? String(text).trim() : null,
      category !== undefined ? (category ? String(category).trim() : null) : existing.rows[0].category,
      id,
    ]
  );

  return result.rows[0];
});

fastify.delete('/api/objections/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  // ON DELETE CASCADE on rebuttals.objection_id takes care of the children.
  const result = await pool.query('DELETE FROM objections WHERE id = $1 RETURNING id', [id]);

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Objection not found' });
  }

  return { ok: true };
});

fastify.post('/api/objections/:id/rebuttals', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { text } = request.body || {};

  if (!text || !String(text).trim()) {
    return reply.code(400).send({ error: 'text is required' });
  }

  const objection = await pool.query('SELECT id FROM objections WHERE id = $1', [id]);
  if (objection.rows.length === 0) {
    return reply.code(404).send({ error: 'Objection not found' });
  }

  const result = await pool.query(
    `INSERT INTO rebuttals (objection_id, text, created_by)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [id, String(text).trim(), request.user.id]
  );

  return reply.code(201).send(result.rows[0]);
});

fastify.patch('/api/rebuttals/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const { text } = request.body || {};

  if (!text || !String(text).trim()) {
    return reply.code(400).send({ error: 'text is required' });
  }

  const result = await pool.query(
    `UPDATE rebuttals SET text = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [String(text).trim(), id]
  );

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Rebuttal not found' });
  }

  return result.rows[0];
});

fastify.delete('/api/rebuttals/:id', { preHandler: [requireAuth] }, async (request, reply) => {
  const { id } = request.params;
  const result = await pool.query('DELETE FROM rebuttals WHERE id = $1 RETURNING id', [id]);

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: 'Rebuttal not found' });
  }

  return { ok: true };
});

// ─── Phase 2: WebSocket audio endpoint ───────────────────────────────────────
// GET /meetings/:id/audio → upgraded to WebSocket
// Accepts binary PCM audio (16 kHz linear16) from client
// Streams to Deepgram, broadcasts transcript events back

/**
 * Authenticate a WebSocket request via session cookie.
 * Returns user record or null.
 */
async function authWebSocket(request) {
  const { user } = await authWebSocketWithSession(request);
  return user;
}

// 2026-08-05: same auth resolution as authWebSocket() above, but also
// returns the raw sessionId that authenticated the connection — needed by
// the new live-meeting-sync WS routes below (GET /api/sync,
// GET /meetings/:id/observe) to know which session is on the other end,
// e.g. so a meeting's OWNING session opening its own /observe socket
// (unusual but not disallowed) isn't confusing to distinguish from a truly
// different session in logs. Not used by the existing audio route, which
// only ever needed the user record — kept as a separate function rather
// than changing authWebSocket()'s existing return shape, so that route's
// call site needed zero changes.
async function authWebSocketWithSession(request) {
  const cookieHeader = request.headers.cookie || '';
  // Parse cookies manually
  const cookies = {};
  cookieHeader.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });

  // Native-client fallback (2026-08-03): React Native's WebSocket upgrade
  // request does not reliably carry the httpOnly session_id cookie the way
  // a browser's does (this was flagged as an open risk when the mobile app
  // was scaffolded, now confirmed in practice on a real device). Since the
  // cookie is httpOnly, the mobile client can't read and resend it manually
  // either — so the login response now also returns the raw session id in
  // the JSON body (mobile-only; the web PWA ignores that field and keeps
  // using the cookie as before), and the mobile WS client passes it as a
  // `?session=` query param on the upgrade request. Cookie auth remains the
  // primary/preferred path for the web app; this is strictly additive.
  const sessionId = cookies['session_id'] || request.query?.session;
  const session = await getSession(sessionId);
  if (!session) return { user: null, sessionId: null };

  const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [session.userId]);
  return { user: result.rows[0] || null, sessionId };
}

// Uploaded-recording playback: the browser retains and plays the source file,
// sending only decoded 16 kHz mono PCM at 1x pace. This route intentionally
// bypasses mic consent, Twilio, voiceprint and in-person introduction logic.
async function finalizeUploadedRecording(meetingId) {
  const updated = await pool.query(
    `UPDATE meetings SET status = 'completed', ended_at = COALESCE(ended_at, NOW())
     WHERE id = $1 AND status = 'active' AND channel = $2 RETURNING id, rep_id`,
    [meetingId, UPLOADED_RECORDING_CHANNEL]
  );
  if (updated.rows.length !== 1) throw new Error('Uploaded recording was already completed');

  // Preserve the normal terminal analysis contract. Coaching snapshots are
  // already generated live; summary generation below uses the same persisted
  // transcript and prompt as POST /api/meetings/:id/summary, without storing
  // source audio anywhere.
  let summaryText = null;
  const segments = await pool.query(
    `SELECT speaker, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
    [meetingId]
  );
  const transcriptText = segments.rows.length
    ? segments.rows.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n')
    : '(No transcript recorded)';
  if (anthropicPrimaryText.availability.textGeneration === 'missing') {
    summaryText = '⚠️ Summary generation requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY. Please provision a key and try again.\n\n' +
      `Transcript preview (first 500 chars):\n${transcriptText.slice(0, 500)}`;
  } else {
    try {
      const generated = await anthropicPrimaryText.generate({
        model: 'claude-haiku-4-5', maxTokens: 1500,
        system: `You are ARIA, a sales coach for CertaPro Painters field reps. Write a structured plain-text meeting summary with: MEETING OVERVIEW, SALES STAGE, CHECKLIST COVERAGE, WHAT WAS MISSED, and ACTION ITEMS.`,
        messages: [{ role: 'user', content: `Meeting transcript:\n\n${transcriptText}` }],
      });
      summaryText = generated.text;
    } catch (error) {
      fastify.log.error(`uploaded recording summary generation failed for ${meetingId} (${formatAiFailure(error)})`);
      throw error;
    }
  }
  await pool.query('UPDATE meetings SET summary = $1 WHERE id = $2', [summaryText, meetingId]);
  notifyUserSyncMeetingEnded(updated.rows[0].rep_id, meetingId);
  if (process.env.ENABLE_AUTO_TITLE_GENERATION === 'true') {
    generateAutoTitleForMeeting(meetingId).catch((error) => fastify.log.error(`uploaded recording auto-title failed: ${error.message}`));
  }
  return { summary: summaryText };
}

await registerUploadedRecordingRoutes(fastify, {
  pool,
  requireAuth,
  authWebSocketWithSession,
  apiKey: DEEPGRAM_API_KEY,
  broadcastToMeeting,
  registerMeetingSocket,
  unregisterMeetingSocket,
  runCoachingAnalysis,
  finalizeMeeting: finalizeUploadedRecording,
  registerSpeakerController,
  unregisterSpeakerController,
});

// ── Live meeting sync (mobile → web), 2026-08-05 ── GET /api/sync (account-level) ─
// A logged-in session opens this ONCE (e.g. on app/tab load, independent of
// whether any specific meeting page is open) to learn in near-real-time
// whenever a mobile-originated meeting starts or ends for their own
// user_id. This is the mechanism that lets a rep's web tab pop the "meeting
// in progress" dialog WITHOUT the user having navigated to that meeting or
// refreshed anything first — satisfying requirement 1's "automatically
// detect" language. Deliberately separate from the per-meeting /observe
// socket below: /api/sync only ever sends two tiny control messages
// (`meeting_started` / `meeting_ended`) and never the transcript firehose,
// so a session that's just sitting on the Home screen isn't paying for or
// receiving live-transcript traffic it isn't displaying.
//
// Catch-up on connect: if a mobile-originated meeting is ALREADY active for
// this user_id at the moment this socket opens (e.g. the rep started a
// mobile meeting, then opened a web tab a minute later), this sends the
// same `meeting_started` message immediately — the client doesn't have to
// have been connected at the exact moment the meeting was created to learn
// about it.
fastify.get('/api/sync', { websocket: true }, async (socket, request) => {
  const { user } = await authWebSocketWithSession(request);
  if (!user) {
    socket.close(4001, 'Unauthorized');
    return;
  }

  registerUserSyncSocket(user.id, socket);

  try {
    const active = await pool.query(
      `SELECT id, customer_id, started_at, title FROM meetings
       WHERE rep_id = $1 AND status = 'active' AND origin_client = 'mobile'
       ORDER BY started_at DESC LIMIT 1`,
      [user.id]
    );
    if (active.rows.length > 0 && socket.readyState === 1) {
      const m = active.rows[0];
      socket.send(JSON.stringify({
        type: 'meeting_started',
        meeting: { id: m.id, customer_id: m.customer_id, started_at: m.started_at, title: m.title },
      }));
    }
  } catch (err) {
    // Most likely cause: origin_client column not yet migrated (42703). A
    // session with no already-active meeting to catch up on is a fully
    // valid, common state — don't fail the whole connection over this;
    // the socket stays open and will still receive live meeting_started
    // pushes from notifyUserSyncMeetingStarted() once that column exists.
    fastify.log.warn(`/api/sync catch-up query failed (likely pending migration): ${err.message}`);
  }

  socket.on('close', () => {
    unregisterUserSyncSocket(user.id, socket);
  });
  socket.on('error', () => {
    unregisterUserSyncSocket(user.id, socket);
  });
});

// ── Live meeting sync (mobile → web), 2026-08-05 ── GET /meetings/:id/observe ─
// Read-only per-meeting sync socket. Opened by the synced web dialog once
// it knows (via GET /api/sync's meeting_started push, or the REST fallback
// GET /api/meetings/active below) which meetingId to watch. Relays the
// SAME live message types the owner's /meetings/:id/audio connection
// already produces (interim/final transcript, speaker_lock/unlock/merge,
// coaching, suggested_rebuttal — see broadcastToMeeting()'s call sites) so
// the dialog can show "live transcript/feedback" per requirement 2, reusing
// the existing pipeline rather than standing up a second one. This route
// NEVER accepts audio frames from the client and never opens its own
// Deepgram connection — it is intentionally receive-only from the client's
// perspective (any message the client sends here is ignored).
//
// Ownership/ACL: same rep_id-or-admin rule as every other /api/meetings/:id
// read route (a synced session belongs to the SAME account as the meeting
// owner, by definition of how it got the meetingId via /api/sync — this is
// just the existing meeting-visibility rule, not a new one). This route
// does NOT expose any way to send an end/finalize command — there is no
// message handler that writes to `meetings` at all on this socket; the only
// enforcement surface for "can't end from here" is (and must be) the
// PATCH /api/meetings/:id route's owner_session_id check, which this
// socket has no bearing on either way.
fastify.get('/meetings/:meetingId/observe', { websocket: true }, async (socket, request) => {
  const { meetingId } = request.params;
  const user = await authWebSocket(request);
  if (!user) {
    socket.close(4001, 'Unauthorized');
    return;
  }

  let meeting;
  try {
    const res = await pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId]);
    if (res.rows.length === 0) {
      socket.close(4004, 'Meeting not found');
      return;
    }
    meeting = res.rows[0];
    if (!hasAdminAccess(user.role) && meeting.rep_id !== user.id) {
      socket.close(4003, 'Forbidden');
      return;
    }
  } catch (err) {
    fastify.log.error('WS observe meeting lookup error:', err);
    socket.close(1011, 'Internal error');
    return;
  }

  registerObserverSocket(meetingId, socket);

  // Send an initial snapshot so the dialog isn't blank until the next live
  // transcript line arrives — mirrors what GET /api/meetings/:id/coaching/latest
  // + GET /api/meetings/:id/segments already give the web PWA's own
  // MeetingPage on load, just pushed proactively over this socket instead of
  // requiring the client to also call those REST routes itself.
  try {
    const segResult = await pool.query(
      `SELECT id, speaker, text, ts FROM transcript_segments WHERE meeting_id = $1 ORDER BY ts ASC`,
      [meetingId]
    );
    const coachingResult = await pool.query(
      `SELECT snapshot FROM coaching_snapshots WHERE meeting_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [meetingId]
    );
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'sync_snapshot',
        meeting: { id: meeting.id, status: meeting.status, started_at: meeting.started_at },
        segments: segResult.rows,
        coaching: coachingResult.rows[0]?.snapshot || null,
      }));
    }
  } catch (err) {
    fastify.log.error(`observe snapshot fetch error for meeting ${meetingId}: ${err.message}`);
  }

  socket.on('close', () => {
    unregisterObserverSocket(meetingId, socket);
  });
  socket.on('error', () => {
    unregisterObserverSocket(meetingId, socket);
  });
});

fastify.get('/meetings/:meetingId/audio', { websocket: true }, async (socket, request) => {
  const { meetingId } = request.params;

  // Auth
  const { user, sessionId: requestSessionId } = await authWebSocketWithSession(request);
  if (!user) {
    socket.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
    socket.close(4001, 'Unauthorized');
    return;
  }

  // Verify meeting + ownership. Load the associated customer name as
  // canonical supporting evidence for the introduction state machine.
  let meeting;
  try {
    const res = await pool.query(
      `SELECT m.*, c.name AS customer_name
       FROM meetings m LEFT JOIN customers c ON m.customer_id = c.id
       WHERE m.id = $1`,
      [meetingId]
    );
    if (res.rows.length === 0) {
      socket.send(JSON.stringify({ type: 'error', error: 'Meeting not found' }));
      socket.close(4004, 'Meeting not found');
      return;
    }
    meeting = res.rows[0];
    if (!hasAdminAccess(user.role) && meeting.rep_id !== user.id) {
      socket.send(JSON.stringify({ type: 'error', error: 'Forbidden' }));
      socket.close(4003, 'Forbidden');
      return;
    }
    // ── Live meeting sync (mobile → web), 2026-08-05 ── defense in depth ──────
    // The synced web dialog is supposed to use the read-only
    // /meetings/:id/observe route (no audio, no Deepgram, no writes), never
    // this audio-streaming route — the web UI never links/opens this WS for
    // a meeting it didn't start. This check is a server-side backstop for
    // that assumption (same "don't just hide it in the UI" principle the
    // task requires for the End Meeting button): if owner_session_id IS
    // recorded for this meeting, only THAT session may open a NEW
    // audio-streaming connection to it. A NULL owner_session_id (pre-
    // migration meeting, or migration not applied) is permissive —
    // unchanged pre-existing behavior.
    if (meeting.owner_session_id && requestSessionId !== meeting.owner_session_id) {
      socket.send(JSON.stringify({ type: 'error', error: 'This meeting is already being recorded from another device.' }));
      socket.close(4003, 'Not the owning session');
      return;
    }
  } catch (err) {
    fastify.log.error('WS meeting lookup error:', err);
    socket.close(1011, 'Internal error');
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    socket.send(JSON.stringify({ type: 'error', error: 'Deepgram not configured on server' }));
    socket.close(1011, 'Deepgram not configured');
    return;
  }

  fastify.log.info(`WS audio: meeting ${meetingId} user ${user.id} connected`);

  // Register socket for coaching push
  registerMeetingSocket(meetingId, socket);

  // ── pyannoteAI scaffolding (2026-08-04) ── SCAFFOLDING, NOT LIVE ─────────────
  // Where a pyannoteAI streaming client WOULD be started in parallel with
  // the existing Deepgram connection below, once PYANNOTE_API_KEY exists.
  // pyannoteAI runs ALONGSIDE Deepgram (Deepgram stays the transcription
  // engine); pyannoteAI would supply diarization events + drive async
  // /identify calls (via voicePrint.js), with results relabeled onto the
  // transcript using speakerRelabel.js's state machine — NOT wired into the
  // existing speakerLocks/speakerChunks logic below, which is left
  // untouched per this task's scope. Left commented out (not merely env-
  // gated-and-inert) because it isn't wired to feed anything real yet —
  // uncommenting requires deciding how its diarization events reconcile
  // with the existing Deepgram-driven speaker indices first.
  //
  // let pyannoteStream = null;
  // if (pyannote.isConfigured()) {
  //   pyannoteStream = new pyannote.PyannoteStreamClient({
  //     onSpeakerStart: (data) => fastify.log.info(`pyannoteAI speaker_start: ${JSON.stringify(data)}`),
  //     onSpeakerEnd: (data) => fastify.log.info(`pyannoteAI speaker_end: ${JSON.stringify(data)}`),
  //     onError: (msg) => fastify.log.error(`pyannoteAI stream error: ${msg}`),
  //     log: (msg) => fastify.log.info(msg),
  //   });
  //   await pyannoteStream.start();
  // }
  // Then, in the socket.on('message', ...) audio-forwarding handler further
  // below, alongside the existing `dgSocket.send(data)` line, add:
  //   if (pyannoteStream) {
  //     const int16 = new Int16Array(data.buffer ?? data, data.byteOffset ?? 0, (data.byteLength ?? data.length) / 2);
  //     pyannoteStream.pushAudio(int16);
  //   }
  // And on socket.on('close', ...): `if (pyannoteStream) pyannoteStream.end();`

  // ── Voice fingerprint matching setup ──────────────────────────────────────
  let repName = user.name || 'Rep';
  const enrolledFeatures = await loadEnrolledVoicePrint(voiceFingerprintPolicy, async () => {
    const vpResult = await pool.query(
      'SELECT features FROM voice_prints WHERE user_id = $1', [user.id]
    );
    if (vpResult.rows.length === 0) return null;
    fastify.log.info(`Voice print loaded for ${repName}`);
    return vpResult.rows[0].features;
  });

  // Rolling audio ring buffer (16kHz) — always active for speaker
  // de-duplication. When enabled it also feeds rep-voiceprint matching.
  // below. A 60s window comfortably covers Deepgram's processing latency
  // without buffering an entire (potentially hour-long) call in memory.
  const RING_SECONDS = 60;
  const RING_SAMPLES = 16000 * RING_SECONDS;
  const voiceRing = new Float32Array(RING_SAMPLES);
  let ringPos = 0;
  let ringWritten = 0;

  function ringWrite(int16) {
    for (let i = 0; i < int16.length; i++) {
      voiceRing[ringPos] = int16[i] / 32768;
      ringPos = (ringPos + 1) % RING_SAMPLES;
      ringWritten++;
    }
  }

  // Slice absolute-sample range [fromAbs, toAbs) out of the ring buffer.
  // Returns null if the range is invalid, not yet written, or already
  // overwritten (fell outside the rolling window).
  function ringSlice(fromAbs, toAbs) {
    fromAbs = Math.max(0, Math.floor(fromAbs));
    toAbs = Math.min(ringWritten, Math.ceil(toAbs));
    if (toAbs <= fromAbs) return null;
    const len = toAbs - fromAbs;
    if (len > RING_SAMPLES || ringWritten - fromAbs > RING_SAMPLES) return null;
    const out = new Float32Array(len);
    const startPos = ((fromAbs % RING_SAMPLES) + RING_SAMPLES) % RING_SAMPLES;
    for (let i = 0; i < len; i++) out[i] = voiceRing[(startPos + i) % RING_SAMPLES];
    return out;
  }

  const speakerChunks = {}; // canonical speaker id -> Float32Array[] (rep-voiceprint match)
  const speakerLocks = {};  // canonical speaker id (string) -> displayName
  const speakerLockSources = {}; // canonical speaker id -> manual|introduction|voiceprint
  // Persisted labels include older manual UI choices and prior introduction
  // resolutions after a reconnect. Seed them before any inference runs.
  for (const [speakerId, name] of Object.entries(meeting.speaker_labels || {})) {
    const parsed = /Speaker\s+(\d+)/i.exec(speakerId);
    if (!parsed || !String(name || '').trim()) continue;
    const si = String(parseInt(parsed[1], 10) - 1);
    speakerLocks[si] = String(name).trim();
    speakerLockSources[si] = meeting.speaker_label_evidence?.[si]?.method === 'introduction' ? 'introduction' : 'manual';
  }
  let voiceMatchDone = false;

  const persistedIntroEvidence = meeting.speaker_label_evidence || {};
  // `channel=phone` covers both rep-phone and browser/Twilio meetings. The
  // CallSid exclusion is defense in depth against a malformed/legacy row.
  // Keep all introduction heuristics behind this one explicit guard.
  const isInPersonIntroductionMeeting = isEligibleInPersonMeeting(meeting);
  const introductionLabeler = createInPersonIntroductionLabeler({
    meetingType: isInPersonIntroductionMeeting ? meeting.channel : 'excluded',
    repDisplayName: repName,
    customerDisplayName: meeting.customer_name || null,
    startedAtMs: new Date(meeting.started_at || Date.now()).getTime(),
    existingLocks: Object.fromEntries(
      Object.entries(speakerLocks).map(([si, name]) => [si, { name, source: speakerLockSources[si] }])
    ),
    existingEvidence: persistedIntroEvidence,
    onConflict: (conflict) => fastify.log.warn(`In-person introduction conflict for ${meetingId}: ${JSON.stringify(conflict)}`),
    resolveIdentity: async ({ speakerIndex, name, role, evidence }) => {
      const si = String(speakerIndex);
      const current = speakerLocks[si];
      if (current) return { resolved: false, reason: current === name ? 'idempotent' : 'locked' };

      // Reserve the live slot before DB I/O so another finalized segment
      // cannot race through and assign it differently.
      speakerLocks[si] = name;
      speakerLockSources[si] = 'introduction_pending';
      const speakerId = `Speaker ${speakerIndex + 1}`;
      let result;
      try {
        result = await persistIntroductionResolution({
          pool, meetingId, speakerIndex, name, evidence,
        });
      } catch (err) {
        delete speakerLocks[si];
        delete speakerLockSources[si];
        throw err;
      }
      if (!result.resolved) {
        delete speakerLocks[si];
        delete speakerLockSources[si];
        return result;
      }

      meeting.speaker_labels = result.speakerLabels;
      meeting.speaker_label_evidence = result.speakerLabelEvidence;
      speakerLocks[si] = name;
      speakerLockSources[si] = 'introduction';
      broadcastToMeeting(meetingId, {
        type: 'speaker_lock',
        speakerId,
        name,
        role,
        source: 'introduction',
        confidence: evidence.confidence,
      });
      fastify.log.info(`In-person introduction resolved ${speakerId} -> ${name} (${role}, ${evidence.pattern})`);
      return { resolved: true };
    },
  });

  // ── Mid-call name-introduction: 15s collection window + confirm popup ─────
  // (2026-08-10, Gabe Bass intro-window fix). Two-part behavior:
  //   Part 1 (nameHeuristics.isLikelyName): reject common-word false positives
  //           like "I'm starting this meeting" -> "Starting".
  //   Part 2 (here): don't auto-lock at all anymore. Collect intro candidates
  //           per speaker slot for the first INTRO_WINDOW_MS of that slot's
  //           presence, THEN emit a `speaker_lock_suggestion` and wait for a
  //           human to confirm/reject via POST /api/meetings/:id/speaker-lock
  //           (bridged back into this closure by the speaker controller
  //           registered below). Never touches the voice-print lock path.
  const INTRO_WINDOW_MS = 15000;           // collect for 15s before guessing
  const INTRO_SUGGEST_COOLDOWN_MS = 20000; // don't re-nag with the same slot faster than this
  const speakerFirstSeen = {};             // si (string) -> ms slot first observed
  const introCandidates = {};              // si -> Map(nameLower -> { name, count })
  const rejectedIntroNames = {};           // si -> Set(nameLower) the user said "No" to
  const pendingIntroSuggestion = {};       // si -> nameLower currently awaiting a user answer
  const introSuggestCooldownUntil = {};    // si -> ms; suppress re-suggest until then

  // ── ROOT-CAUSE FIX (2026-08-11, Gabe Bass: "no popup ever appears") ───────
  // The `elapsed >= INTRO_WINDOW_MS` check was ONLY ever evaluated inside
  // the per-segment `dgSocket.on('message', ...)` handler below, gated on a
  // NEW final transcript segment landing on that exact speaker slot (`si`).
  // That means the 15s window was measured correctly, but the check that
  // compares elapsed-vs-window only RAN when the same speaker produced
  // another final segment. Real calls overwhelmingly do not look like that:
  // a customer says one line ("Hi, I'm John") and then goes quiet for the
  // next 30-90s while the rep talks — the rep's finals never touch the
  // customer's `si` key, so the customer's own elapsed-time check is never
  // re-evaluated, and the window closing produces no suggestion at all
  // unless/until that exact speaker happens to speak again. Confirmed live
  // against prod transcript_segments (meetings d344ad78-... and aef1531a-...,
  // 2026-08-12): both contain "I'm <name>" introductions that DID pass
  // isLikelyName()/introRe (verified directly against nameHeuristics.js),
  // yet neither meeting has ANY 'speaker_lock_suggestion' in the Railway
  // runtime logs for that deployment — because in both transcripts the
  // introducing speaker's very next segment already carries a DIFFERENT
  // (already-resolved) canonical si after a dedup merge, or simply never
  // produces a same-slot final again before the window would have closed.
  // Fix: decouple the elapsed-time check from "did a final segment just
  // land" by ALSO sweeping every known speaker slot on a fixed interval
  // timer, independent of new transcript activity. `maybeSuggestIntro(si)`
  // is the single shared implementation — the per-segment call site below
  // now just accumulates candidates and delegates the elapsed-check/emit
  // to this function, and the sweep timer calls the exact same function.
  function maybeSuggestIntro(si, nowIntro) {
    if (!isInPersonIntroductionMeeting) return;
    if (speakerLocks[si]) return;
    const elapsed = nowIntro - (speakerFirstSeen[si] ?? nowIntro);
    const cooldownOk = nowIntro >= (introSuggestCooldownUntil[si] || 0);
    if (
      elapsed >= INTRO_WINDOW_MS &&
      !pendingIntroSuggestion[si] &&
      cooldownOk &&
      introCandidates[si] && introCandidates[si].size > 0
    ) {
      const best = [...introCandidates[si].values()].sort((a, b) => b.count - a.count)[0];
      if (best) {
        pendingIntroSuggestion[si] = best.name.toLowerCase();
        introSuggestCooldownUntil[si] = nowIntro + INTRO_SUGGEST_COOLDOWN_MS;
        fastify.log.info(`Speaker intro SUGGESTION: Speaker ${parseInt(si, 10) + 1} may be "${best.name}" (awaiting user confirm)`);
        broadcastToMeeting(meetingId, {
          type: 'speaker_lock_suggestion',
          speakerId: `Speaker ${parseInt(si, 10) + 1}`,
          name: best.name,
        });
      }
    }
  }

  // Sweep every 3s so a suggestion fires ~on time even if the introducing
  // speaker doesn't produce another final segment before the window closes
  // (the actual bug — see comment above). Cheap: iterates a handful of
  // speaker-slot keys, no I/O. Cleared on socket close alongside every other
  // per-connection timer in this handler.
  const INTRO_SWEEP_MS = 3000;
  const introSweepTimer = setInterval(() => {
    const nowSweep = Date.now();
    for (const si of Object.keys(speakerFirstSeen)) {
      maybeSuggestIntro(si, nowSweep);
    }
  }, INTRO_SWEEP_MS);
  if (typeof introSweepTimer.unref === 'function') introSweepTimer.unref();
  // 
  // closure's live `speakerLocks` state. Registered now, unregistered on close.
  const speakerLockController = {
    // Parse a client-facing "Speaker N" label back to the 0-based canonical si
    // string used as the key in speakerLocks/introCandidates/etc.
    _siFromLabel(speakerId) {
      const m = /Speaker\s+(\d+)/i.exec(String(speakerId || ''));
      if (!m) return null;
      return String(parseInt(m[1], 10) - 1);
    },
    confirm(speakerId, name) {
      const si = this._siFromLabel(speakerId);
      if (si === null) return { ok: false, error: 'bad speakerId' };
      const display = toDisplayName(name) || String(name || '').trim();
      if (!display) return { ok: false, error: 'empty name' };
      // Respect the invariant: never override an existing lock (voice-print or
      // an already-confirmed intro). A confirm on an already-locked slot is a
      // no-op success (idempotent for double-clicks / observer echoes).
      if (!speakerLocks[si]) {
        speakerLocks[si] = display;
        speakerLockSources[si] = 'manual';
        introductionLabeler.setManualLock(si, display);
        fastify.log.info(`Speaker intro CONFIRMED by user: Speaker ${parseInt(si, 10) + 1} -> ${display}`);
      }
      delete pendingIntroSuggestion[si];
      broadcastToMeeting(meetingId, {
        type: 'speaker_lock',
        speakerId: `Speaker ${parseInt(si, 10) + 1}`,
        name: speakerLocks[si],
      });
      return { ok: true, locked: speakerLocks[si] };
    },
    manualLock(speakerId, name) {
      const si = this._siFromLabel(speakerId);
      if (si === null) return { ok: false, error: 'bad speakerId' };
      const display = String(name || '').trim();
      if (!display) return { ok: false, error: 'empty name' };
      speakerLocks[si] = display;
      speakerLockSources[si] = 'manual';
      introductionLabeler.setManualLock(si, display);
      return { ok: true, locked: display };
    },
    reject(speakerId, name) {
      const si = this._siFromLabel(speakerId);
      if (si === null) return { ok: false, error: 'bad speakerId' };
      const nameLower = String(name || '').trim().toLowerCase();
      if (nameLower) {
        if (!rejectedIntroNames[si]) rejectedIntroNames[si] = new Set();
        rejectedIntroNames[si].add(nameLower);
        // Drop the rejected name from the candidate tally so it can't win again.
        if (introCandidates[si]) introCandidates[si].delete(nameLower);
      }
      delete pendingIntroSuggestion[si];
      // Short cooldown so we don't instantly re-suggest the NEXT candidate in
      // the same breath — give the call a moment. We keep listening (do NOT
      // lock, do NOT give up on this speaker for the rest of the meeting).
      introSuggestCooldownUntil[si] = Date.now() + INTRO_SUGGEST_COOLDOWN_MS;
      fastify.log.info(`Speaker intro REJECTED by user: Speaker ${parseInt(si, 10) + 1} not "${name}" — still listening`);
      // Let other synced clients dismiss their popup too.
      broadcastToMeeting(meetingId, {
        type: 'speaker_lock_suggestion_dismiss',
        speakerId: `Speaker ${parseInt(si, 10) + 1}`,
      });
      return { ok: true };
    },
  };
  registerSpeakerController(meetingId, speakerLockController);
  const MIN_MATCH_SAMPLES = 16000 * 5;  // 5s per speaker before a candidate is eligible
  const MATCH_THRESHOLD = 0.72;         // raised from 0.58 — tighter bar, fewer false positives

  // ── Wait-and-compare rep-match locking (fixes first-past-post mislabeling) ───
  // Old behavior locked onto whichever speaker slot crossed the threshold
  // FIRST, even if that slot was actually the customer. Instead: once a
  // candidate is eligible, hold the decision open for a grace window so any
  // other active speaker can also become eligible, then lock onto whichever
  // scores highest — and only if it clears the raised threshold AND beats
  // the runner-up by a real margin (not just clearing an absolute bar).
  const candidateScores = {};      // canonical si (string) -> latest similarity score
  const candidateReadyAt = {};     // canonical si (string) -> ms timestamp first became eligible
  let matchGraceDeadline = null;   // ms timestamp; decide once we reach this (or max-wait)
  const MATCH_GRACE_MS = 4000;     // base wait for a second candidate to catch up
  const MATCH_GRACE_EXTEND_MS = 1500; // extra wait granted when top two are close
  const MATCH_MAX_WAIT_MS = 15000; // hard cap from first-eligible candidate — don't wait forever
  const MATCH_MARGIN = 0.08;       // top must beat runner-up by this much to lock early

  // ── Drift re-verification ("is the lock still correct?") ───────────────
  // A bad initial lock previously stuck for the entire call (voiceMatchDone
  // disabled all further checking). Now: keep sampling the locked speaker's
  // ongoing audio and periodically re-score against the enrolled print. If
  // confidence collapses — wrong initial lock, or Deepgram silently
  // re-indexed speaker slots mid-call — unlock and let the matcher
  // re-evaluate from scratch.
  let lockedSpeakerId = null;
  let driftChunks = [];
  let lastDriftCheckAt = 0;
  const DRIFT_CHECK_INTERVAL_MS = 25000; // re-check roughly every 25s of locked speech
  const DRIFT_MIN_SAMPLES = 16000 * 4;   // need 4s of fresh locked-speaker audio to re-check
  const DRIFT_UNLOCK_THRESHOLD = 0.45;   // below this, assume mismatch/drift — unlock

  // ── ARIA Priority 1 roadmap, item 5: Live rebuttal teleprompter ──────────
  // ⚠️ FIRST-PASS SCAFFOLDING, PARTIALLY REAL — see objectionDetection.js's
  // module docstring for the full real-vs-stubbed breakdown. Summary:
  //   - Detection (detectObjection()): STUB. Cheap synchronous regex/keyword
  //     match against the prospect's just-finalized segment text. Zero added
  //     latency, but NOT a real classifier — no ML, no negation handling, no
  //     confidence score. Good enough to prove the end-to-end WS plumbing
  //     works; not good enough to trust blindly at real call volume.
  //   - Rebuttal generation (generateRebuttal() in coachingAnalysis.js): REAL.
  //     An actual Claude-via-OpenRouter call, same pipeline/model as the rest
  //     of the coaching engine. This is genuinely LLM-generated, not a
  //     canned string.
  //   - Recent-segment context buffer (last handful of finalized segments,
  //     rep + prospect) kept short deliberately — full-transcript context
  //     would add both LLM cost and latency for marginal benefit on a
  //     single-turn rebuttal suggestion.
  //   - Per-category cooldown prevents the same objection type from
  //     re-triggering a fresh LLM call (and re-interrupting the rep's live
  //     coaching feed) more than once per COOLDOWN_MS window, even if the
  //     prospect keeps repeating similar phrasing.
  const recentSegmentContext = []; // rolling buffer of { speaker, text }, both rep + prospect
  const RECENT_CONTEXT_MAX = 6;
  const rebuttalCooldownUntil = {}; // category -> ms timestamp until re-eligible
  const REBUTTAL_COOLDOWN_MS = 45000; // 45s — avoid spamming suggestions for a repeated objection

  // ── Live rebuttal TELEPROMPTER: Objections/Rebuttals library matcher ────
  // (2026-08-18, second pass). Loaded ONCE per WS connection (not per
  // segment) — cheap, and the library rarely changes mid-call. Empty array
  // if the library is empty OR the objections/rebuttals migration hasn't
  // been applied yet (current prod state) — loadObjectionMatcherIndex()
  // never throws, so this line can never break meeting setup. Awaited here
  // (not fire-and-forget) because it's a single cheap query pair and the
  // rest of this handler's setup already does sequential awaited queries
  // (voice_prints lookup just above) before the socket starts handling
  // real audio.
  let objectionMatcherIndex = await loadObjectionMatcherIndex(pool, (m) => fastify.log.info(m));

  // ── Speaker de-duplication (merge over-segmented speaker indices) ─────────
  // Deepgram's streaming diarizer can spawn a "new" speaker index mid-call
  // for the same person (pause, pitch/cadence shift, background noise). Before
  // trusting a raw index as genuinely new, compare its accumulated audio
  // against already-established speaker reference fingerprints and merge if
  // it's really the same voice. Threshold is intentionally stricter than the
  // rep-match threshold — falsely merging two DIFFERENT real people would be
  // worse than leaving an over-segmented split alone.
  const speakerAlias = {};        // rawSi -> canonical Si (once resolved as a merge)
  const speakerRefFeatures = {};  // canonical Si -> reference voice features
  const speakerRefChunks = {};    // rawSi -> Float32Array[] (pending, pre-resolution)
  const DEDUP_MIN_SAMPLES = 16000 * 3; // 3s before attempting a merge check
  // Raised 0.80 -> 0.92 (2026-08-03): the underlying spectral-feature matcher
  // (centroid/rolloff/zcr/energy/spread) is too coarse to reliably discriminate
  // between two DIFFERENT real people on the same mic/room, especially over
  // short clips — was causing distinct customer voices to be falsely merged
  // into whichever speaker slot became canonical first (frequently the rep).
  // This is a stopgap; the real fix is replacing this matcher with a proper
  // voice-embedding model (pyannoteAI), planned for the Aria Phone Channel
  // work and worth extending to this in-person pipeline too.
  const DEDUP_MERGE_THRESHOLD = 0.92;  // stricter bar than rep-match (0.58)

  function resolveSpeaker(rawSi) {
    let cur = rawSi;
    let hops = 0;
    while (speakerAlias[cur] !== undefined && hops < 8) {
      cur = speakerAlias[cur];
      hops++;
    }
    return cur;
  }

  async function maybeMergeSpeaker(rawSi) {
    if (speakerAlias[rawSi] !== undefined) return; // already resolved
    // A proven/manual identity is an authoritative boundary. Do not allow the
    // coarse spectral deduper to collapse it into or out of another slot.
    if (speakerLocks[String(rawSi)]) return;
    if (speakerRefFeatures[rawSi] !== undefined) return; // already its own canonical
    const chunks = speakerRefChunks[rawSi];
    if (!chunks) return;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (total < DEDUP_MIN_SAMPLES) return;

    const combined = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.length; }
    const features = extractVoiceFeatures(combined);

    let bestMatch = null;
    let bestScore = 0;
    for (const [canonicalSi, refFeatures] of Object.entries(speakerRefFeatures)) {
      if (Number(canonicalSi) === rawSi) continue;
      // Never merge a new/unresolved speaker into the currently-locked rep slot.
      // Previously any voice scoring high enough against the rep's fingerprint
      // (even a different real person, given the matcher's weak discrimination)
      // would get silently relabeled as the rep. The rep's identity is already
      // established via the dedicated voiceprint-lock flow above — this merge
      // step should only ever consolidate customer-side over-segmentation, not
      // reassign someone else's voice onto the rep.
      if (lockedSpeakerId !== null && Number(canonicalSi) === Number(lockedSpeakerId)) continue;
      if (speakerLocks[String(canonicalSi)]) continue;
      const score = similarityScore(features, refFeatures);
      if (score > bestScore) { bestScore = score; bestMatch = Number(canonicalSi); }
    }

    if (bestMatch !== null && bestScore >= DEDUP_MERGE_THRESHOLD) {
      const introAlias = introductionLabeler.addAlias(rawSi, bestMatch);
      if (!introAlias.aliased && introAlias.reason === 'locked') return;
      speakerAlias[rawSi] = bestMatch;
      fastify.log.info(`Speaker dedup: Speaker ${rawSi + 1} merged into Speaker ${bestMatch + 1} (score=${bestScore.toFixed(3)})`);

      const staleLabel = speakerLocks[String(rawSi)] || `Speaker ${rawSi + 1}`;
      const canonicalLabel = speakerLocks[String(bestMatch)] || `Speaker ${bestMatch + 1}`;
      if (staleLabel !== canonicalLabel) {
        try {
          await pool.query(
            `UPDATE transcript_segments SET speaker = $1 WHERE meeting_id = $2 AND speaker = $3`,
            [canonicalLabel, meetingId, staleLabel]
          );
        } catch (dbErr) {
          fastify.log.error('transcript_segments relabel error:', dbErr);
        }
        // 2026-08-05 live-sync fix: was socket.send() (owner-only) — any
        // read-only /observe session watching this meeting (see
        // broadcastToMeeting()) never received this relabel, so a synced
        // web view would show the stale speaker tag forever. Route through
        // broadcastToMeeting() like every other live message type below so
        // the owner AND observers both get it from one call site.
        broadcastToMeeting(meetingId, { type: 'speaker_merge', from: staleLabel, to: canonicalLabel });
      }
      delete speakerRefChunks[rawSi];
    } else {
      speakerRefFeatures[rawSi] = features;
      delete speakerRefChunks[rawSi];
    }
  }

  // ── Open Deepgram streaming connection (nova-3 + latest diarization model) ────

  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    diarize_model: 'latest',   // latest GA diarizer — best accuracy, supersedes diarize=true
    interim_results: 'true',
    utterance_end_ms: '1000',  // flush utterance after 1s silence for tighter segments
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  }).toString();

  let dgSocket = null;
  let dgReady = false;
  const audioQueue = [];
  let closed = false;
  let reconnectTimer = null;

  // 2026-08-18 hardening (this pass, root cause of 8/4 + 8/9 outages): the
  // reconnect loop below used to retry immediately-ish forever (previously
  // hardened 2026-08-10 to 1s→30s + an 8-failures/5-min circuit breaker,
  // but STILL with no jitter and no real time budget). No jitter meant
  // many concurrent meetings failing at the same moment (e.g. a shared
  // backend blip) would all retry on the exact same schedule — a
  // synchronized stampede against the single backend replica, which is
  // suspected to have made the 8/9 outage worse, not just a symptom of it.
  // Delegated to the shared dgReconnectPolicy.js tracker: 250ms→8s
  // jittered backoff, a ~60s time budget as the PRIMARY give-up control,
  // and a ~14-attempt seatbelt as a backstop. Also now emits >2s
  // lapse/reconnect notices to the transcript (see onLapseStart/onLapseEnd
  // below) — the old code only ever spoke up once the ENTIRE breaker
  // tripped (up to 8 failures across 5 minutes = minutes of silent dead
  // air), never on the first user-perceptible stall.
  const dgTracker = createReconnectTracker({
    log: (m) => fastify.log.info(`[meeting ${meetingId}] ${m}`),
    onLapseStart: (startedAtMs) => {
      fastify.log.warn(`Deepgram lapse (>2s) for meeting ${meetingId}, started ${new Date(startedAtMs).toISOString()}`);
      broadcastToMeeting(meetingId, { type: 'transcription_lapse', state: 'started', startedAt: startedAtMs });
    },
    onLapseEnd: (durationMs) => {
      fastify.log.info(`Deepgram lapse recovered for meeting ${meetingId} after ${durationMs}ms`);
      broadcastToMeeting(meetingId, { type: 'transcription_lapse', state: 'recovered', durationMs });
    },
    onGiveUp: (reason) => {
      fastify.log.error(
        `Deepgram reconnect give-up for meeting ${meetingId}: ${reason}. ` +
        `Giving up on Deepgram reconnects for this session; live transcription is degraded.`
      );
      try {
        broadcastToMeeting(meetingId, {
          type: 'transcription_lapse',
          state: 'stopped',
          message: 'Live transcription has stopped for this meeting. The call recording is still being captured and the transcript can be backfilled afterward.',
        });
      } catch (e) {
        fastify.log.error(`Failed to broadcast Deepgram give-up notice for meeting ${meetingId}: ${e.message}`);
      }
    },
  });

  function connectDeepgram() {
    if (closed || dgTracker.isGivenUp()) return;

    dgSocket = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dgSocket.on('open', () => {
      dgReady = true;
      dgTracker.onConnected();
      fastify.log.info(`Deepgram connected for meeting ${meetingId}`);
      const queued = audioQueue.splice(0);
      queued.forEach(buf => {
        if (dgSocket.readyState === WebSocket.OPEN) dgSocket.send(buf);
      });
    });

    dgSocket.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type !== 'Results') return;

      const alt = msg?.channel?.alternatives?.[0];
      if (!alt) return;

      const text = (alt.transcript || '').trim();
      if (!text) return;

      // Extract speaker from word-level diarization (1-indexed for display)
      // — resolved through the de-dup alias map so an over-segmented "new"
      // index that's really the same person collapses to its canonical id.
      const words = alt.words || [];
      let rawSpeakerIdx = resolveSpeaker(words.length > 0 && words[0].speaker !== undefined ? words[0].speaker : 0);
      let speaker = speakerLocks[String(rawSpeakerIdx)] || `Speaker ${rawSpeakerIdx + 1}`;

      // Feed per-word audio slices into the de-dup accumulator (always) and
      // the rep-voiceprint accumulator (only while a rep fingerprint is
      // enrolled and not yet matched).
      if (words.length > 0) {
        for (const word of words) {
          if (word.start === undefined || word.end === undefined) continue;
          const rawSi = word.speaker ?? 0;
          const wordAudio = ringSlice(word.start * 16000, word.end * 16000);
          if (!wordAudio || wordAudio.length < 100) continue;

          // De-dup accumulation (raw index, pre-resolution)
          if (speakerAlias[rawSi] === undefined && speakerRefFeatures[rawSi] === undefined) {
            if (!speakerRefChunks[rawSi]) speakerRefChunks[rawSi] = [];
            speakerRefChunks[rawSi].push(wordAudio);
            await maybeMergeSpeaker(rawSi);
          }

          // Rep-voiceprint accumulation (resolved/canonical index)
          if (voiceFingerprintPolicy.accumulateMatchingAudio && enrolledFeatures && !voiceMatchDone) {
            const canonicalSi = String(resolveSpeaker(rawSi));
            if (!speakerChunks[canonicalSi]) speakerChunks[canonicalSi] = [];
            speakerChunks[canonicalSi].push(wordAudio);
          }

          // Drift re-verification accumulation (only for the currently-locked
          // rep speaker, only after a lock exists)
          if (voiceFingerprintPolicy.runDriftUnlock && enrolledFeatures && voiceMatchDone && lockedSpeakerId !== null) {
            const canonicalSi = String(resolveSpeaker(rawSi));
            if (canonicalSi === lockedSpeakerId) {
              driftChunks.push(wordAudio);
            }
          }
        }

        // ── Wait-and-compare: evaluate rep-match candidates, lock on best-with-margin ──
        if (voiceFingerprintPolicy.runAutomaticMatchAndLock && enrolledFeatures && !voiceMatchDone) {
          const now = Date.now();
          for (const [si, chunks] of Object.entries(speakerChunks)) {
            if (speakerLocks[si]) continue;
            const total = chunks.reduce((s, c) => s + c.length, 0);
            if (total < MIN_MATCH_SAMPLES) continue;
            const combined = new Float32Array(total);
            let off = 0;
            for (const c of chunks) { combined.set(c, off); off += c.length; }
            const features = extractVoiceFeatures(combined);
            const score = similarityScore(features, enrolledFeatures);
            candidateScores[si] = score;
            if (candidateReadyAt[si] === undefined) candidateReadyAt[si] = now;
            if (matchGraceDeadline === null) matchGraceDeadline = now + MATCH_GRACE_MS;
            fastify.log.info(`Voice match candidate Speaker ${si}: score=${score.toFixed(3)}`);
          }

          if (matchGraceDeadline !== null && Object.keys(candidateScores).length > 0) {
            const earliestReady = Math.min(...Object.values(candidateReadyAt));
            const pastGrace = now >= matchGraceDeadline;
            const pastMaxWait = now - earliestReady >= MATCH_MAX_WAIT_MS;

            if (pastGrace || pastMaxWait) {
              const ranked = Object.entries(candidateScores).sort((a, b) => b[1] - a[1]);
              const [bestSi, bestScore] = ranked[0];
              const secondScore = ranked.length > 1 ? ranked[1][1] : null;
              const marginOk = secondScore === null || (bestScore - secondScore) >= MATCH_MARGIN;

              if (bestScore >= MATCH_THRESHOLD && (marginOk || pastMaxWait)) {
                speakerLocks[bestSi] = repName;
                speakerLockSources[bestSi] = 'voiceprint';
                introductionLabeler.setManualLock(bestSi, repName);
                voiceMatchDone = true;
                lockedSpeakerId = bestSi;
                lastDriftCheckAt = now;
                driftChunks = [];
                fastify.log.info(
                  `Voice match: Speaker ${bestSi} → ${repName} (score=${bestScore.toFixed(3)}, ` +
                  `margin=${secondScore !== null ? (bestScore - secondScore).toFixed(3) : 'n/a'}, ` +
                  `waited=${now - earliestReady}ms)`
                );
                // 2026-08-05 live-sync fix: was socket.send() (owner-only)
                // — see broadcastToMeeting() call sites throughout this
                // handler; every OTHER live message type already fans out to
                // observers, this one didn't, so a synced view's speaker
                // labels never got auto-identified even when the owner's did.
                broadcastToMeeting(meetingId, {
                  type: 'speaker_lock',
                  speakerId: `Speaker ${parseInt(bestSi, 10) + 1}`,
                  name: repName,
                });
              } else if (!marginOk && !pastMaxWait) {
                // Close race between two candidates — give it a bit more audio
                // before forcing a decision.
                matchGraceDeadline = now + MATCH_GRACE_EXTEND_MS;
              }
            }
          }
        } else if (voiceFingerprintPolicy.runDriftUnlock && enrolledFeatures && voiceMatchDone && lockedSpeakerId !== null) {
          // ── Drift re-verification: is the lock still holding up? ──
          const driftTotal = driftChunks.reduce((s, c) => s + c.length, 0);
          const now = Date.now();
          if (driftTotal >= DRIFT_MIN_SAMPLES && (now - lastDriftCheckAt) >= DRIFT_CHECK_INTERVAL_MS) {
            const combined = new Float32Array(driftTotal);
            let off = 0;
            for (const c of driftChunks) { combined.set(c, off); off += c.length; }
            const features = extractVoiceFeatures(combined);
            const score = similarityScore(features, enrolledFeatures);
            lastDriftCheckAt = now;
            driftChunks = [];
            fastify.log.info(`Drift check Speaker ${lockedSpeakerId}: score=${score.toFixed(3)}`);
            if (score < DRIFT_UNLOCK_THRESHOLD) {
              fastify.log.warn(`Voice match drift detected — unlocking Speaker ${lockedSpeakerId} (score=${score.toFixed(3)})`);
              delete speakerLocks[lockedSpeakerId];
              voiceMatchDone = false;
              const unlockedSpeakerId = lockedSpeakerId;
              lockedSpeakerId = null;
              // Reset candidate/accumulation state so matching starts fresh
              for (const k of Object.keys(candidateScores)) delete candidateScores[k];
              for (const k of Object.keys(candidateReadyAt)) delete candidateReadyAt[k];
              matchGraceDeadline = null;
              for (const k of Object.keys(speakerChunks)) delete speakerChunks[k];
              // 2026-08-05 live-sync fix: broadcastToMeeting(), not
              // socket.send() — same reasoning as the speaker_lock fix above.
              broadcastToMeeting(meetingId, {
                type: 'speaker_unlock',
                speakerId: `Speaker ${parseInt(unlockedSpeakerId, 10) + 1}`,
                reason: 'drift_detected',
              });
            }
          }
        }
      }

      const isFinal = msg.is_final === true;

      if (isFinal) {
        // Split segment by speaker changes within the word list. Keep full
        // word objects (not just text) so we can compute word_count/duration_ms
        // per group for WPM analytics.
        const speakerGroups = [];
        let curSpeakerIdx = null;
        let curWords = [];
        for (const w of words) {
          const si = resolveSpeaker(w.speaker ?? rawSpeakerIdx);
          if (si !== curSpeakerIdx) {
            if (curWords.length > 0) speakerGroups.push({ si: curSpeakerIdx, words: curWords });
            curSpeakerIdx = si;
            curWords = [];
          }
          curWords.push(w);
        }
        if (curWords.length > 0) speakerGroups.push({ si: curSpeakerIdx, words: curWords });
        // Fallback: if no word-level data, use the full text as one group with
        // no timing info (word_count approximated, duration unknown).
        if (speakerGroups.length === 0) speakerGroups.push({ si: rawSpeakerIdx, words: null, fallbackText: text });

        let segmentCount = 0;
        for (const group of speakerGroups) {
          const groupText = group.words
            ? group.words.map(w => w.punctuated_word || w.word || '').join(' ').trim()
            : (group.fallbackText || '').trim();
          if (!groupText) continue;
          const si = String(group.si);

          // Word cadence data for WPM scoring — null duration when we don't
          // have real word timestamps (fallback path).
          let groupWordCount = null;
          let groupDurationMs = null;
          if (group.words && group.words.length > 0) {
            groupWordCount = group.words.length;
            const timedWords = group.words.filter(w => w.start !== undefined && w.end !== undefined);
            if (timedWords.length > 0) {
              const firstStart = timedWords[0].start;
              const lastEnd = timedWords[timedWords.length - 1].end;
              if (lastEnd > firstStart) groupDurationMs = Math.round((lastEnd - firstStart) * 1000);
            }
          } else {
            groupWordCount = groupText.split(/\s+/).filter(Boolean).length;
          }

          // ── Mid-call name introduction: collect-then-confirm (2026-08-10) ────
          // Rewritten from the old "first sentence wins, auto-lock silently"
          // behavior that produced Gabe's "I'm starting this meeting" ->
          // "Starting" bug. Two changes:
          //   1. Candidate words are validated with isLikelyName() (dictionary
          //      signal), not a hand-picked stopword blocklist.
          //   2. We do NOT auto-lock. We record the slot's first-seen time,
          //      accumulate intro candidates for INTRO_WINDOW_MS, then emit a
          //      `speaker_lock_suggestion` and wait for a human to confirm via
          //      POST /api/meetings/:id/speaker-lock. Never overrides an
          //      existing lock (voice-print or an already-confirmed intro).
          const nowIntro = Date.now();
          if (speakerFirstSeen[si] === undefined) speakerFirstSeen[si] = nowIntro;

          if (isInPersonIntroductionMeeting && !speakerLocks[si]) {
            // Gather EVERY intro-trigger candidate in this segment (a rep may
            // say "I'm John, and this is Sarah" — both are captured; the human
            // confirmation step resolves any mis-attribution to the wrong slot).
            const introRe = /\b(?:i'?m|i am|this is|my name is|name'?s)\s+([A-Za-z][A-Za-z'’-]{1,20})\b/gi;
            let m;
            while ((m = introRe.exec(groupText)) !== null) {
              const raw = m[1];
              if (!isLikelyName(raw)) continue;               // Part 1: reject "starting", "trying", ...
              const display = toDisplayName(raw);
              const nameLower = display.toLowerCase();
              if (rejectedIntroNames[si] && rejectedIntroNames[si].has(nameLower)) continue; // user already said No
              if (!introCandidates[si]) introCandidates[si] = new Map();
              const prev = introCandidates[si].get(nameLower);
              introCandidates[si].set(nameLower, { name: display, count: (prev ? prev.count : 0) + 1 });
            }

            // 2026-08-11 root-cause fix: the elapsed-time check + suggestion
            // emit used to live inline here, which meant it only ran when
            // THIS speaker slot produced another final segment. Delegated to
            // maybeSuggestIntro() so the SAME check also runs on the sweep
            // timer above, independent of new transcript activity — see the
            // fix comment near introSweepTimer's declaration for why that
            // matters. Still called here too (not just from the sweep) so a
            // suggestion can fire immediately on this segment if the window
            // already elapsed, rather than waiting up to INTRO_SWEEP_MS.
            maybeSuggestIntro(si, nowIntro);
          }

          let groupLabel = speakerLocks[si] || `Speaker ${group.si + 1}`;
          // 2026-08-09: capture the newly-inserted row's UUID (RETURNING id)
          // so the 'final' broadcast below can carry the same stable id the
          // REST /segments route and WS sync_snapshot now expose, instead of
          // leaving live-pushed segments as the one path with no id. If the
          // insert fails, insertedSegmentId stays undefined and the broadcast
          // simply omits `id` (unchanged fallback behavior for that segment).
          let insertedSegmentId;
          let insertedSegmentTs;
          try {
            const insertResult = await pool.query(
              `INSERT INTO transcript_segments (meeting_id, ts, speaker, text, word_count, duration_ms) VALUES ($1, NOW(), $2, $3, $4, $5) RETURNING id, ts`,
              [meetingId, groupLabel, groupText, groupWordCount, groupDurationMs]
            );
            insertedSegmentId = insertResult.rows[0]?.id;
            insertedSegmentTs = insertResult.rows[0]?.ts;
          } catch (dbErr) {
            fastify.log.error('transcript_segments insert error:', dbErr);
          }

          // Introduction evidence references the transcript row just inserted;
          // no second recording/audio copy is made. Resolution may relabel this
          // and all prior rows before the live final event is emitted.
          if (insertedSegmentId && introductionLabeler.enabled) {
            try {
              await introductionLabeler.onSegment({
                id: insertedSegmentId,
                speakerIndex: group.si,
                text: groupText,
                ts: insertedSegmentTs || new Date().toISOString(),
                timestampMs: insertedSegmentTs ? new Date(insertedSegmentTs).getTime() : Date.now(),
              });
              groupLabel = speakerLocks[si] || groupLabel;
            } catch (introErr) {
              // Label inference must never interrupt recording/transcription.
              fastify.log.error(`In-person introduction labeling error for ${meetingId}: ${introErr.message}`);
            }
          }
          // ── 2026-08-05 live-sync ROOT-CAUSE FIX ──────────────────────────
          // This was socket.send() (owner-audio-socket only). That is the
          // actual live transcript line — the single most important message
          // this whole route produces — and it NEVER reached any
          // /meetings/:id/observe session. Every observer-side "transcript not
          // transferring" symptom traces back to this one call site (plus
          // the identical `interim` bug just below): the read-only synced
          // dialog was, from day one, only ever going to receive
          // `sync_snapshot` (the one-time initial catch-up) and `coaching`
          // (which already used broadcastToMeeting()) — never a single live
          // `final` line after that. broadcastToMeeting() sends to the
          // owner's own registered socket(s) in activeMeetingSockets AND any
          // observer sockets in activeMeetingObservers, so this one-line
          // change is the fix: owner behavior is 100% unchanged (still gets
          // this message, still to the same socket), observers now do too.
          broadcastToMeeting(meetingId, { type: 'final', id: insertedSegmentId, text: groupText, speaker: groupLabel });

          // ── ARIA Priority 1 roadmap, item 5: Live rebuttal teleprompter ──────
          // Keep a short rolling context buffer of every finalized segment
          // (rep + prospect), then run the STUB objection detector against
          // non-rep (prospect) segments only. Rep-labeled segments never
          // trigger detection — an objection is something the PROSPECT raises.
          // "Non-rep" here uses the same repName-comparison convention
          // computeMeetingAnalytics() already uses elsewhere in this file,
          // not a new heuristic.
          recentSegmentContext.push({ speaker: groupLabel, text: groupText });
          if (recentSegmentContext.length > RECENT_CONTEXT_MAX) recentSegmentContext.shift();

          const isProspectSegment = groupLabel !== repName;

          // ── Live rebuttal teleprompter (library-backed, 2026-08-18 2nd pass) ──
          // CUSTOMER SPEECH ONLY, and only once speaker attribution is
          // actually RESOLVED for this slot — not just "doesn't currently
          // equal repName". Before a lock exists, `groupLabel` is the
          // generic `Speaker N` placeholder for EVERY unresolved speaker,
          // including the rep before their voiceprint matches or before an
          // intro is confirmed; treating that placeholder as "prospect" would
          // risk firing a rebuttal off the rep's own words pre-lock. Per this
          // task's explicit requirement: if attribution is unresolved,
          // silence is preferred over a wrong on-screen prompt. Attribution
          // is "resolved" here iff speakerLocks[si] is set (rep identified
          // via voiceprint OR this specific speaker slot's name was
          // confirmed via the intro-suggestion flow) AND that resolved name
          // is not the rep's own name.
          const attributionResolved = Boolean(speakerLocks[si]);
          const isConfirmedProspectSegment = attributionResolved && isProspectSegment;
          if (isConfirmedProspectSegment && objectionMatcherIndex.length > 0) {
            const libraryMatch = evaluateLibraryMatch(groupText, objectionMatcherIndex, meetingId);
            if (libraryMatch) {
              markPromptFired(meetingId, libraryMatch.objection.id);
              broadcastToMeeting(meetingId, {
                type: 'suggested_rebuttal_library',
                objectionId: libraryMatch.objection.id,
                objectionText: libraryMatch.objection.text,
                objectionCategory: libraryMatch.objection.category,
                rebuttals: libraryMatch.objection.rebuttals,
                matchedSegmentText: groupText,
                confidence: libraryMatch.confidence,
                matchMethod: libraryMatch.method,
              });
            }
          }

          if (isProspectSegment && OPENROUTER_API_KEY) {
            const objection = detectObjection(groupText);
            if (objection) {
              const now = Date.now();
              const cooldownUntil = rebuttalCooldownUntil[objection.category] || 0;
              if (now >= cooldownUntil) {
                rebuttalCooldownUntil[objection.category] = now + REBUTTAL_COOLDOWN_MS;
                const contextSnapshot = recentSegmentContext.slice();
                // Fire-and-forget: do NOT await inline in the hot Deepgram-message
                // handler — the LLM round-trip must not block processing of the
                // next transcript chunk. Push to the client as soon as it
                // resolves, same broadcast pattern as the existing coaching push.
                generateRebuttal(OPENROUTER_API_KEY, meetingId, objection.category, groupText, contextSnapshot)
                  .then(rebuttalText => {
                    if (!rebuttalText) return;
                    // 2026-08-05 live-sync fix: broadcastToMeeting(), not
                    // socket.send() — same class of bug as `final`/`interim`
                    // above; an observer watching a mobile meeting deserves
                    // the same rebuttal teleprompter the owner sees.
                    broadcastToMeeting(meetingId, {
                      type: 'suggested_rebuttal',
                      objectionCategory: objection.category,
                      objectionText: groupText,
                      rebuttal: rebuttalText,
                      // Explicit stub/real flag surfaced to the client so the UI
                      // (and anyone reading a WS log) can tell detection was
                      // heuristic even though the rebuttal text itself is real
                      // LLM output. Remove once detectObjection() is replaced
                      // with a real classifier.
                      detectionMethod: 'stub_keyword_match',
                    });
                  })
                  .catch(err => fastify.log.error('generateRebuttal error:', err.message));
              }
            }
          }
        }
        // Get updated segment count for coaching trigger
        try {
          const countRes = await pool.query(
            `SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = $1`, [meetingId]
          );
          segmentCount = parseInt(countRes.rows[0].count, 10);
        } catch { /* ignore */ }
        if (segmentCount >= 3 && OPENROUTER_API_KEY) {
          runCoachingAnalysis(meetingId)
            .then(coaching => {
              if (coaching) broadcastToMeeting(meetingId, { type: 'coaching', data: coaching });
            })
            .catch(err => fastify.log.error('Auto-coaching error:', err.message));
        }
      } else {
        // Interim: use first speaker (splitting interims is too noisy)
        // 2026-08-05 live-sync fix: broadcastToMeeting(), not socket.send()
        // — same root-cause bug as `final` above.
        const interimLabel = speakerLocks[String(rawSpeakerIdx)] || `Speaker ${rawSpeakerIdx + 1}`;
        broadcastToMeeting(meetingId, { type: 'interim', text, speaker: interimLabel });
      }
    });

    dgSocket.on('close', (code) => {
      dgReady = false;
      fastify.log.warn(`Deepgram closed (code=${code}) for meeting ${meetingId}`);
      if (closed) return;

      const result = dgTracker.onDisconnect();
      if (result.giveUp) return; // dgTracker already invoked onGiveUp above
      reconnectTimer = setTimeout(connectDeepgram, result.delayMs);
    });

    dgSocket.on('error', (err) => {
      fastify.log.error('Deepgram WS error:', err.message);
    });
  }

  connectDeepgram();

  // ── Handle audio from client ──────────────────────────────────────────────

  socket.on('message', (data) => {
    if (dgReady && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(data);
    } else {
      const totalBuffered = audioQueue.reduce((s, b) => s + b.byteLength, 0);
      if (totalBuffered < 960_000) audioQueue.push(Buffer.from(data));
    }
    // Feed the rolling audio ring buffer — always on for speaker de-duplication;
    // the automatic rep matcher reads from it only when its feature flag is on.
    const int16 = new Int16Array(data.buffer ?? data, data.byteOffset ?? 0, (data.byteLength ?? data.length) / 2);
    ringWrite(int16);
  });

  // ── Client disconnected ───────────────────────────────────────────────────

  socket.on('close', () => {
    fastify.log.info(`WS client disconnected: meeting ${meetingId}`);
    closed = true;
    unregisterMeetingSocket(meetingId, socket);
    unregisterSpeakerController(meetingId, speakerLockController);
    clearInterval(introSweepTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    dgTracker.dispose();
    if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
      try {
        dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => dgSocket.terminate(), 2000);
      } catch {
        dgSocket.terminate();
      }
    }
    // 2026-08-05 root-cause fix: don't let this meeting stay 'active'
    // forever just because this particular client socket went away. See
    // `finalizeMeetingIfAbandoned` above for the full reasoning (terminal
    // status choice, grace-period rationale). Scheduled rather than
    // immediate so a client that reconnects within the grace window (the
    // web PWA's own exponential-backoff auto-reconnect) isn't punished for
    // a transient blip.
    setTimeout(() => {
      finalizeMeetingIfAbandoned(meetingId).catch((err) => {
        fastify.log.error(`finalizeMeetingIfAbandoned threw for meeting ${meetingId}: ${err.message}`);
      });
    }, ABANDONED_MEETING_GRACE_MS);
  });

  socket.on('error', (err) => {
    fastify.log.error('Client WS error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await loadKnowledgeBase();
  await ensureSessionsTable();
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`ARIA server running on port ${PORT}`);
  console.log(`WebSocket audio endpoint: ws://localhost:${PORT}/meetings/:id/audio`);
  console.log(`Coaching endpoint: POST /api/meetings/:id/coaching`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
