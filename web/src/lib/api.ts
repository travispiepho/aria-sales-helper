/**
 * api.ts — Typed API client for ARIA
 * Uses fetch with credentials: 'include' to send session cookies
 */

const BASE = import.meta.env.VITE_API_URL || '';

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
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'rep' | 'admin';
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
}

export async function createMeeting(customerId?: string): Promise<Meeting> {
  return request('POST', '/api/meetings', { customer_id: customerId });
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
