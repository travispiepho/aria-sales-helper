/**
 * api.ts — Typed API client for ARIA
 * Uses fetch with credentials: 'include' to send session cookies
 */

import type { Role } from './roles';

const BASE = import.meta.env.VITE_API_URL || '';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Raw fetch with credentials + BASE URL — use when you need the full Response
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(error.error || `HTTP ${res.status}`, res.status);
  }

  return res.json();
}

// Auth

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  // Rep's own phone number on file (added 2026-08-13), E.164-normalized by
  // the server. Null/undefined if the rep hasn't saved one yet. Used to
  // prefill PhoneCallModal.tsx's "Your Phone Number" field.
  phone?: string | null;
}

export async function login(email: string, password: string): Promise<{ user: User }> {
  return request('POST', '/api/auth/login', { email, password });
}

export async function logout(): Promise<void> {
  return request('POST', '/api/auth/logout');
}

export async function getMe(): Promise<{ user: User }> {
  return request('GET', '/api/auth/me');
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('PATCH', '/api/account/password', { currentPassword, newPassword });
}

// Profile: self-service phone number (added 2026-08-13). Pass '' or null to
// clear a previously saved number. See server.js's PATCH /api/profile.
export async function updateProfile(phone: string | null): Promise<{ user: User }> {
  return request('PATCH', '/api/profile', { phone });
}

// Admin: user management (2026-08-10). Currently list + soft-delete only;
// the queued follow-up work will add a create-account POST on the same
// URL prefix. Both endpoints return 403 to non-admin callers server-side
// (see server.js's request.user.role !== 'admin' guard), so a rep who
// somehow lands on /admin/users will get an error instead of a list.

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
  // NULL for active accounts, ISO-8601 timestamp for soft-deleted ones.
  deactivated_at: string | null;
}

export async function listAdminUsers(): Promise<{ users: AdminUser[] }> {
  return request('GET', '/api/admin/users');
}

export interface DeleteAdminUserResult {
  ok: boolean;
  user: { id: string; name: string; email: string; role: Role };
  // Number of live session rows that were revoked as part of the delete
  // (i.e. tabs the deactivated user had signed in on). Surfaced so the
  // UI can show 'kicked out N sessions' in the confirmation toast; not
  // load-bearing for correctness.
  sessions_revoked: number;
}

export async function deleteAdminUser(id: string): Promise<DeleteAdminUserResult> {
  return request('DELETE', `/api/admin/users/${id}`);
}

// Admin: invite a new user + claim code (2026-08-18).
//
// ⚠️ NOT EMAIL VERIFICATION. POST /api/admin/invite persists a pending
// invite AND returns a one-time plaintext claim code that the admin must
// relay to the rep out-of-body (text message or in person) — nothing is
// emailed. The rep then completes signup at /signup with (email, claim
// code, password) via claimInvite() below. See server.js's route comment
// block for the full rationale (no email-sending capability, no verified
// sending domain, no stable public URL yet).
export type InviteRole = 'admin' | 'rep';

export interface Invite {
  id: string;
  email: string;
  role: InviteRole;
  invited_by: string;
  created_at: string;
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string | null;
  accepted_at?: string | null;
}

export interface InviteUserResult {
  ok: boolean;
  invite: Invite;
  // Plaintext claim code — present ONLY in this response and the
  // regenerate response below. Never persisted client-side beyond the
  // current screen; the backend never returns it again after this call.
  claimCode: string;
}

export async function inviteUser(email: string, role: InviteRole): Promise<InviteUserResult> {
  return request('POST', '/api/admin/invite', { email, role });
}

export async function listInvites(): Promise<{ invites: Invite[] }> {
  return request('GET', '/api/admin/invites');
}

export async function regenerateInviteClaimCode(
  id: string
): Promise<{ ok: boolean; invite: Invite; claimCode: string }> {
  return request('POST', `/api/admin/invites/${id}/regenerate`);
}

export async function revokeInvite(id: string): Promise<{ ok: boolean; invite: Invite }> {
  return request('POST', `/api/admin/invites/${id}/revoke`);
}

// Public signup claim (2026-08-18) — no auth required, this IS how an
// invited rep gets their first session. See server.js's POST
// /api/signup/claim for the full security model (generic errors, rate
// limiting, single-use, atomic).
export interface ClaimInviteResult {
  ok: boolean;
  user: { id: string; name: string; email: string; role: Role };
}

export async function claimInvite(
  email: string,
  claimCode: string,
  password: string
): Promise<ClaimInviteResult> {
  return request('POST', '/api/signup/claim', { email, claimCode, password });
}

// Customers

export interface Customer {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  source?: string;
  created_by?: string;
  created_at: string;
}

export interface CustomerInput {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  source?: string;
}

export async function createCustomer(data: CustomerInput): Promise<Customer> {
  return request('POST', '/api/customers', data);
}

export async function listCustomers(): Promise<Customer[]> {
  return request('GET', '/api/customers');
}

export async function getCustomer(id: string): Promise<Customer> {
  return request('GET', `/api/customers/${id}`);
}

// Meetings

export interface Meeting {
  id: string;
  customer_id?: string;
  rep_id: string;
  started_at: string;
  ended_at?: string;
  // 'interrupted' added 2026-08-05 (server-side auto-finalize on abandoned
  // WS connections — see server.js's finalizeMeetingIfAbandoned()). Was
  // missing from this union even though the DB CHECK constraint and server
  // responses have allowed it since that migration landed — harmless at
  // runtime (isActive/statusBadge() both have safe fallbacks for an
  // unrecognized status) but wrong for type-checking, fixed here in passing.
  status: 'active' | 'completed' | 'cancelled' | 'interrupted';
  summary?: string;
  title?: string;
  rep_name?: string;
  customer_name?: string;
  speaker_labels?: Record<string, string>;
  // 2026-08-05 (live meeting sync full-page rebuild): which APP originally
  // started this meeting. Used purely for the small "synced from phone"
  // indicator/copy in MeetingPage's observer view — NOT the field that
  // gates functional differences (mic/End Meeting), see is_owner_session.
  origin_client?: 'mobile' | 'web';
  // 2026-08-05 (live meeting sync full-page rebuild): true if THIS session
  // (the one making this request) is the session that started/owns this
  // meeting, false if it's a different logged-in session observing a
  // mobile-started meeting, true/undefined for legacy meetings with no
  // recorded owner (permissive default, matches server.js's own
  // permissive-when-NULL enforcement everywhere else this check exists).
  // Computed server-side (server.js's shapeMeetingForClient()) by comparing
  // the request's session cookie against the meeting's owner_session_id —
  // the RAW owner_session_id value itself is never sent to any client.
  // Drives MeetingPage's owner-vs-observer render branches: only an owner
  // session sees the Record button / mic capture / End Meeting control.
  is_owner_session?: boolean;
  // 2026-08-17 (ARIA meeting UI by type). Existing DB column (see
  // migrations/2026-08-04-phone-channel-columns.sql) reused as the
  // meeting-type discriminator this task needed — MeetingPage.tsx branches
  // its recording-button and End Meeting/Hang-Up rendering on this field.
  // 'phone' = a Twilio-bridged "Aria calls the rep" call (server.js's
  // /telephony/outbound-call flow); anything else (including undefined,
  // for pre-channel-column legacy rows) is treated as 'in_person'.
  channel?: 'phone' | 'in_person' | 'uploaded_recording';
  // Set only for meetings actually linked to a Twilio call (both the web
  // outbound "Aria calls the rep" bridge and an inbound customer call);
  // null for mobile's local-mic-capture 'phone'-channel meetings (those are
  // created via plain POST /api/meetings with no Twilio involvement at all
  // — see mobile/src/app/meeting-setup.tsx). `channel === 'phone'` ALONE is
  // NOT a reliable signal that a meeting is Twilio-server-recorded —
  // `channel === 'phone' && !!call_sid` is (see MeetingPage.tsx's
  // isTwilioPhoneCall). Flagged in this task's report as a real
  // discriminator gap that this compound check works around.
  call_sid?: string | null;
  // 2026-08-17 (ARIA meeting UI by type, Part 1). Existing DB columns (see
  // migrations/2026-08-17-meeting-recording-columns.sql), already returned
  // by every `SELECT * FROM meetings` route via shapeMeetingForClient()'s
  // spread — just newly consumed here. `recording_status` mirrors Twilio's
  // recordingStatusCallbackEvent values ('in-progress' | 'completed' |
  // 'absent' | 'failed'), last reported by /telephony/recording-status.
  // This is the REAL server-side recording state; the recording indicator
  // must derive from this (or the live 'recording_state' WS push below),
  // never from an optimistic client timer.
  recording_status?: string | null;
  recording_sid?: string | null;
  recording_url?: string | null;
}

export async function createMeeting(customerId?: string): Promise<Meeting> {
  return request('POST', '/api/meetings', { customer_id: customerId });
}

/** Creates a meeting whose source is a local uploaded recording. */
export async function createUploadedRecordingMeeting(): Promise<Meeting> {
  return request('POST', '/api/meetings', { channel: 'uploaded_recording' });
}

// 2026-08-07: /api/meetings now paginates (limit+offset) so older meetings
// are reachable instead of an unbounded "recent-only" list — see
// server.js's GET /api/meetings for the backend side. Response shape
// changed from a bare Meeting[] to { meetings, hasMore, limit, offset };
// this wrapper's return type follows suit. HomePage.tsx (the only caller)
// is updated in this same pass to page via a "Load more" button.
export interface MeetingsPage {
  meetings: Meeting[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

export async function listMeetings(offset = 0, limit = 20): Promise<MeetingsPage> {
  return request('GET', `/api/meetings?limit=${limit}&offset=${offset}`);
}

export async function getMeeting(id: string): Promise<Meeting> {
  return request('GET', `/api/meetings/${id}`);
}

export interface TranscriptSegment {
  id?: string;
  speaker: string;
  text: string;
  ts: string;
}

export async function getLatestCoaching(id: string): Promise<{ coaching: unknown | null }> {
  return request('GET', `/api/meetings/${id}/coaching/latest`);
}

export async function deleteMeeting(id: string): Promise<void> {
  return request('DELETE', `/api/meetings/${id}`);
}

export async function getMeetingSegments(id: string): Promise<{ segments: TranscriptSegment[] }> {
  return request('GET', `/api/meetings/${id}/segments`);
}

export async function updateMeeting(
  id: string,
  data: Partial<Pick<Meeting, 'status' | 'ended_at' | 'summary' | 'title' | 'speaker_labels'>>
): Promise<Meeting> {
  return request('PATCH', `/api/meetings/${id}`, data);
}

/**
 * Persist a meeting title and read it back from the authenticated API.
 *
 * Browser/WebRTC calls create their meeting from a Twilio webhook, so the UI
 * can learn the meeting ID at nearly the same time that the row becomes
 * readable. Retry only the narrowly-defined 404 creation race; all auth,
 * validation and server failures surface immediately. The final GET proves
 * the value is in the database rather than treating an optimistic UI update
 * as success.
 */
export async function renameMeeting(
  id: string,
  title: string,
  options: { attempts?: number; retryDelayMs?: number } = {}
): Promise<Meeting> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error('Meeting title cannot be empty');

  const attempts = Math.max(1, options.attempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 300);
  let updated: Meeting | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      updated = await updateMeeting(id, { title: normalizedTitle });
      break;
    } catch (error) {
      const isPendingCreation = error instanceof ApiError && error.status === 404;
      if (!isPendingCreation || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }

  if (!updated) throw new Error('Meeting title was not saved');
  const persisted = await getMeeting(id);
  if (persisted.title !== normalizedTitle) {
    throw new Error('The meeting title could not be verified. Reload and try again.');
  }
  return persisted;
}

// Post-meeting analytics: WPM, checklist sequencing/timing, Meeting Score

export interface ChecklistTimingItem {
  id: string;
  label: string;
  hit: boolean;
  minutesIn: number | null;
}

export interface WpmPoint {
  minute: number;
  wpm: number | null;
}

export interface MeetingAnalytics {
  wpm: {
    avg: number | null;
    idealMin: number;
    idealMax: number;
    paceFlag: 'slow' | 'fast' | 'good' | null;
    overTime: WpmPoint[];
  };
  checklistTiming: ChecklistTimingItem[];
  sequencing: {
    score: number;
    actualOrder: string[];
    idealOrder: string[];
    lateCriticalItems: { id: string; label: string; minutesIn: number }[];
  };
  coveragePct: number;
  discAdaptationScore: number | null;
  meetingScore: number | null;
  scoreComponents: { key: string; label: string; value: number; weight: number }[];
}

export async function getMeetingAnalytics(id: string): Promise<MeetingAnalytics> {
  return request('GET', `/api/meetings/${id}/analytics`);
}

// ARIA Priority 1 roadmap (2026-08-05): BANT + closing certainty (#1),
// insider-language flagger (#3), question-listening gaps (#4), coaching
// report aggregation (#6). Item #2 (TEPIT) intentionally not implemented.

export interface BantFactor {
  score: number;
  rationale: string;
}

export interface BantScore {
  id: string;
  meeting_id: string;
  budget_score: number;
  authority_score: number;
  need_score: number;
  timeline_score: number;
  closing_certainty_pct: number;
  rationale: {
    budget?: string;
    authority?: string;
    need?: string;
    timeline?: string;
    overall?: string;
  };
  model?: string;
  created_at: string;
  updated_at: string;
}

export async function runBantAnalysis(id: string): Promise<BantScore> {
  return request('POST', `/api/meetings/${id}/bant`);
}

export async function getBantAnalysis(id: string): Promise<{ bant: BantScore | null }> {
  return request('GET', `/api/meetings/${id}/bant`);
}

export interface InsiderLanguageFlag {
  id: string;
  meeting_id: string;
  segment_index: number | null;
  ts: string | null;
  minutes_in: number | null;
  phrase: string;
  explanation: string;
}

export async function runInsiderLanguageAnalysis(id: string): Promise<{ flags: InsiderLanguageFlag[] }> {
  return request('POST', `/api/meetings/${id}/insider-language`);
}

export async function getInsiderLanguageFlags(id: string): Promise<{ flags: InsiderLanguageFlag[] }> {
  return request('GET', `/api/meetings/${id}/insider-language`);
}

export interface QuestionGap {
  id: string;
  meeting_id: string;
  question_segment_index: number | null;
  question_text: string;
  question_ts: string | null;
  question_minutes_in: number | null;
  rep_response_excerpt: string;
  explanation: string;
}

export async function runQuestionGapAnalysis(id: string): Promise<{ gaps: QuestionGap[] }> {
  return request('POST', `/api/meetings/${id}/question-gaps`);
}

export async function getQuestionGaps(id: string): Promise<{ gaps: QuestionGap[] }> {
  return request('GET', `/api/meetings/${id}/question-gaps`);
}

export interface CoachingReport {
  meeting: {
    id: string;
    title?: string;
    customer_name?: string;
    rep_name?: string;
    started_at: string;
    ended_at?: string;
    status: string;
  };
  bant: BantScore | null;
  insiderLanguageFlags: InsiderLanguageFlag[];
  questionGaps: QuestionGap[];
  meetingScore: number | null;
  scoreComponents: { key: string; label: string; value: number; weight: number }[];
  coveragePct: number;
  wpm: MeetingAnalytics['wpm'];
  discAdaptationScore: number | null;
}

export async function getCoachingReport(id: string): Promise<CoachingReport> {
  return request('GET', `/api/meetings/${id}/coaching-report`);
}

// ─── Live meeting sync (mobile → web), 2026-08-05, full-page rebuild ───────
// v1, mobile-origin only. See server.js's "Live meeting sync" comment block
// and useMeetingSyncWatcher.ts for the full design (that hook only
// navigates the tab to /meetings/:id — MeetingPage.tsx itself then reads
// live data via GET /meetings/:id/observe for a non-owner session). This
// REST call is the polling fallback / initial-load check; the real-time
// path is the GET /api/sync WebSocket (opened directly by
// useMeetingSyncWatcher.ts, not through this typed request() helper since
// it's a raw WS, not a fetch).

export interface ActiveSyncMeeting {
  id: string;
  customer_id?: string;
  started_at: string;
  title?: string | null;
  customer_name?: string | null;
}

export async function getActiveSyncMeeting(): Promise<{ active: ActiveSyncMeeting | null }> {
  return request('GET', '/api/meetings/active-sync');
}

// ─── Outbound phone meetings ("Aria calls the rep, then bridges the
// customer"), 2026-08-13 — rep-facing web UI wiring only. This hits
// server/telephony.js's POST /telephony/outbound-call (a top-level route,
// NOT under /api — same auth/session cookie as every other call here since
// request() always sends credentials: 'include'). The endpoint places a
// REAL Twilio call: it rings the rep's own phone first, and once answered
// plays a recorded-call disclosure and bridges the customer in. See
// server/telephony.js's route-level comment block for the full flow and
// PhoneCallModal.tsx (web/src/components) for the calling UI + required
// on-screen recording notice. NOTE: server may return 503 until Twilio
// account setup (phone number / TwiML App SID) finishes on the backend
// side — that is expected and the UI below surfaces it as a real error,
// not a fake success.

export interface OutboundCallResult {
  callSid: string;
  meetingId: string | null;
}

export async function startOutboundCall(
  repPhone: string,
  customerPhone: string,
  customerId?: string
): Promise<OutboundCallResult> {
  return request('POST', '/telephony/outbound-call', {
    repPhone,
    customerPhone,
    ...(customerId ? { customerId } : {}),
  });
}

export interface BrowserCallSetup {
  browserCalling: true;
  token: string;
  pendingCallId: string;
  expiresIn: number;
}

/**
 * Creates a short-lived, server-bound browser-call capability. The token is
 * returned to the caller and kept only in component memory; api.ts never
 * persists or logs it.
 */
export async function createBrowserCall(customerPhone: string): Promise<BrowserCallSetup> {
  return request('POST', '/telephony/browser-token', { customerPhone });
}

export async function getBrowserCallStatus(
  pendingCallId: string
): Promise<{ meetingId: string | null; error: string | null }> {
  return request('GET', `/telephony/browser-call/${encodeURIComponent(pendingCallId)}`);
}

// ─── Objections / Rebuttals library (2026-08-18) ─────────────────────
// Troy Hacker's request ("Rebuttal list to objections" in HighPriority
// Todos). Standalone reference library, shared across all reps — see
// server.js's route-block comment for the auth-model rationale (any
// authenticated rep can create/edit/delete, not admin-gated).

export interface Rebuttal {
  id: string;
  objection_id: string;
  text: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface Objection {
  id: string;
  text: string;
  category?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
  // Only present on the list endpoint (GET /api/objections) — a count
  // computed server-side so the list view can show "3 rebuttals" without
  // fetching every objection's full rebuttal set up front.
  rebuttal_count?: number;
}

export interface ObjectionWithRebuttals extends Objection {
  rebuttals: Rebuttal[];
}

export async function listObjections(): Promise<Objection[]> {
  return request('GET', '/api/objections');
}

export async function getObjection(id: string): Promise<ObjectionWithRebuttals> {
  return request('GET', `/api/objections/${id}`);
}

export async function createObjection(text: string, category?: string): Promise<Objection> {
  return request('POST', '/api/objections', { text, category });
}

export async function updateObjection(
  id: string,
  data: { text?: string; category?: string | null }
): Promise<Objection> {
  return request('PATCH', `/api/objections/${id}`, data);
}

export async function deleteObjection(id: string): Promise<void> {
  return request('DELETE', `/api/objections/${id}`);
}

export async function createRebuttal(objectionId: string, text: string): Promise<Rebuttal> {
  return request('POST', `/api/objections/${objectionId}/rebuttals`, { text });
}

export async function updateRebuttal(id: string, text: string): Promise<Rebuttal> {
  return request('PATCH', `/api/rebuttals/${id}`, { text });
}

export async function deleteRebuttal(id: string): Promise<void> {
  return request('DELETE', `/api/rebuttals/${id}`);
}

// ─── Live rebuttal teleprompter (2026-08-18, in-meeting surfacing pass) ───
// Dismiss a `suggested_rebuttal_library` WS-pushed prompt — sticks for the
// rest of this meeting (server-side per-meeting state, not client-only).
export async function dismissLibraryRebuttal(meetingId: string, objectionId: string): Promise<void> {
  return request('POST', `/api/meetings/${meetingId}/dismiss-rebuttal`, { objectionId });
}
