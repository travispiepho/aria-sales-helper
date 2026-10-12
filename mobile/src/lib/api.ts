/**
 * api.ts — Typed API client for ARIA mobile
 *
 * Mirrors app/web/src/lib/api.ts. Auth model note (read before touching this file):
 *
 * The EXISTING backend (app/server/server.js) is 100% cookie-session based —
 * `POST /api/auth/login` sets an httpOnly `session_id` cookie via
 * `reply.setCookie(...)`, and every authenticated route (including the
 * `/meetings/:id/audio` WebSocket) reads that cookie back off the request.
 * There is no bearer-token auth path anywhere in the backend — we are NOT
 * inventing one here, per the task constraints.
 *
 * React Native's `fetch` is spec-compliant with the Fetch standard, which
 * means (same as a real browser) `Response.headers.get('set-cookie')` is
 * filtered/unreadable from JS — this is not an RN bug, it's the same
 * cookie-security model browsers use. What DOES carry over from the web app
 * unchanged: the native networking stack underneath RN's fetch (NSURLSession
 * on iOS, OkHttp on Android) maintains its own persistent, disk-backed cookie
 * jar and automatically attaches `Cookie` headers on subsequent same-origin
 * requests — this is exactly the mechanism `credentials: 'include'` relies on
 * in the web app, it's just implicit here instead of an explicit fetch option.
 * So plain `fetch()` calls below "just work" for session auth without us
 * touching cookies manually, same as the PWA.
 *
 * What we store in `expo-secure-store` is the last-known authenticated user
 * profile (id/name/email/role) — NOT a raw session token, because RN's fetch
 * never exposes that raw value to JS to store in the first place. This is a
 * UX cache only (instant "logged in as X" on cold start); the actual
 * authorization artifact is the native cookie jar entry, which is itself
 * encrypted-at-rest by the OS and never touched by app code — arguably a
 * stronger guarantee than us copying a token into SecureStore ourselves.
 *
 * ⚠️ FLAGGED FOR FOLLOW-UP (see mobile-app-build-status doc): it is not
 * fully verified in this pass whether RN's native `WebSocket` module shares
 * the same cookie jar as `fetch` on both iOS and Android for the
 * `/meetings/:id/audio` upgrade request — this can only be confirmed with a
 * real device/Expo Go test, which this sandbox cannot run. If the WS
 * handshake doesn't carry the cookie in practice, the clean fix is a backend
 * addition (not attempted here, out of scope): accept the session id as a
 * `?session=` query param on the WS upgrade route as a native-client fallback.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { VoiceFeatures } from '@/lib/voiceFeatures';

const CACHED_USER_KEY = 'aria_cached_user';
// Native-client WS-auth fallback (2026-08-03): confirmed on a real device that
// RN's WebSocket upgrade request does not reliably carry the httpOnly
// session_id cookie the way a browser does. The backend now also returns the
// raw session id in the login JSON response (mobile-only; the web PWA never
// reads this field). Stored here in secure storage — same OS-level encrypted
// store as the cached user profile — and sent as a `?session=` query param
// on the meeting WebSocket URL. This does not weaken the httpOnly cookie's
// protection for the web app; it's an additive, mobile-only auth path.
const SESSION_ID_KEY = 'aria_ws_session_id';

// expo-secure-store wraps native Keychain (iOS) / Keystore (Android) APIs and
// has no real implementation on web — calling it in a browser throws
// ("getValueWithKeyAsync is not a function"), since there's no secure OS-level
// credential store to back it in that environment. This is only ever used
// here to cache a non-sensitive last-known user profile for instant UI on
// cold start (see file header) — the actual auth artifact is the native
// cookie jar — so falling back to localStorage on web is a safe, equivalent
// trade for this narrow use, not a security regression.
const webStore = {
  async getItemAsync(key: string): Promise<string | null> {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  },
  async deleteItemAsync(key: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  },
};

const secureStore = Platform.OS === 'web' ? webStore : SecureStore;

// Backend base URL — same deployed backend the web PWA talks to
// (see app/web/.env.production). Overridable via EXPO_PUBLIC_API_URL for
// local dev against `node server.js` in app/server.
export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || 'https://ariasaleshelper-production.up.railway.app';

export function getWsBase(): string {
  return API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'rep' | 'admin';
}

export async function login(email: string, password: string): Promise<{ user: User }> {
  const result = await request<{ user: User; sessionId?: string }>('POST', '/api/auth/login', { email, password });
  await secureStore.setItemAsync(CACHED_USER_KEY, JSON.stringify(result.user));
  if (result.sessionId) {
    await secureStore.setItemAsync(SESSION_ID_KEY, result.sessionId);
  }
  return result;
}

export async function logout(): Promise<void> {
  try {
    await request('POST', '/api/auth/logout');
  } finally {
    await secureStore.deleteItemAsync(CACHED_USER_KEY);
    await secureStore.deleteItemAsync(SESSION_ID_KEY);
  }
}

// Used by the meeting screen to append `?session=` to the WS URL — see
// SESSION_ID_KEY note above for why this fallback exists.
export async function getStoredSessionId(): Promise<string | null> {
  return secureStore.getItemAsync(SESSION_ID_KEY);
}

// Cross-checks the cached profile against a live /api/auth/me call — the
// cache is only ever used to paint the UI instantly; the network call is the
// source of truth for whether the session cookie is actually still valid.
//
// Root cause fixed here (2026-08-04): `sessionId` was previously only ever
// written to secure storage inside login() — any app session that started
// BEFORE the `?session=` WS fallback shipped (or any secure-store clear
// without a fresh login) had no cached session id, so getStoredSessionId()
// returned null, the WS URL had no `?session=` param, and the connection
// silently fell back to the (broken for native WebSocket) cookie-only path.
// This is why the meeting screen's WS handshake was "still failing" even
// after the backend fallback + login-time fix were both live. Backfilling
// it on every getMe() call (which auth.tsx runs on every app open) closes
// that gap without requiring an explicit log-out/log-in cycle.
export async function getMe(): Promise<{ user: User; sessionId?: string }> {
  const result = await request<{ user: User; sessionId?: string }>('GET', '/api/auth/me');
  await secureStore.setItemAsync(CACHED_USER_KEY, JSON.stringify(result.user));
  if (result.sessionId) {
    await secureStore.setItemAsync(SESSION_ID_KEY, result.sessionId);
  }
  return result;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('PATCH', '/api/account/password', { currentPassword, newPassword });
}

// ─── Voice print (2026-08-10, mobile voice-recognition port) ──────────────
// Mirrors app/web/src/pages/ProfilePage.tsx's inline `apiFetch('/api/profile/voice-print', ...)`
// calls exactly — same EXISTING backend routes (app/server/server.js's
// "Voice print routes" section), same request/response shapes. Not a new
// API surface; just a typed wrapper matching this file's existing
// request()-based pattern instead of web's raw apiFetch() calls.

export interface VoicePrintStatus {
  enrolled: boolean;
  duration_ms?: number;
  created_at?: string;
}

// GET /api/profile/voice-print — check enrollment status. Response shape
// confirmed against server.js: `{ enrolled: false }` or
// `{ enrolled: true, duration_ms, created_at }`.
export async function getVoicePrintStatus(): Promise<VoicePrintStatus> {
  return request('GET', '/api/profile/voice-print');
}

// POST /api/profile/voice-print — enroll or re-enroll (upsert, one print
// per user). Body shape confirmed against server.js:
// `const { features, duration_ms } = request.body` — `features` is the
// VoiceFeatures object from voiceFeatures.ts's extractVoiceFeatures(),
// stored as-is (`JSON.stringify(features)`), same object shape web sends.
export async function saveVoicePrint(features: VoiceFeatures, durationMs: number): Promise<{ ok: boolean }> {
  return request('POST', '/api/profile/voice-print', { features, duration_ms: durationMs });
}

// DELETE /api/profile/voice-print — remove enrollment.
export async function deleteVoicePrint(): Promise<{ ok: boolean }> {
  return request('DELETE', '/api/profile/voice-print');
}

export async function getCachedUser(): Promise<User | null> {
  const raw = await secureStore.getItemAsync(CACHED_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

// ─── Meetings ───────────────────────────────────────────────────────────────

export interface Meeting {
  id: string;
  customer_id?: string;
  rep_id: string;
  started_at: string;
  ended_at?: string;
  status: 'active' | 'completed' | 'cancelled';
  summary?: string;
  title?: string;
  rep_name?: string;
  customer_name?: string;
  speaker_labels?: Record<string, string>;
  // (2026-08-10) Existing backend column (see
  // server/migrations/2026-08-04-phone-channel-columns.sql — despite that
  // file's stale "PROPOSED / SKETCH ONLY — NOT APPLIED" header comment, it
  // IS live in prod: verified via a direct DB query against the `meetings`
  // table, column exists with `DEFAULT 'in_person'`). Mobile now sets this
  // explicitly at meeting-creation time via the new pre-record
  // meeting-type step (see meeting-setup.tsx) instead of always relying on
  // the column default.
  channel?: 'in_person' | 'phone';
}

// (2026-08-10) Meeting channel/type — reuses the EXISTING `channel` column
// on the `meetings` table (see Meeting.channel above), not a new field.
export type MeetingChannel = 'in_person' | 'phone';

// 2026-08-05 (live meeting sync, mobile → web): tags every mobile-created
// meeting with `origin_client: 'mobile'` so the backend's sync feature
// (see server.js's "Live meeting sync" comment block) knows to notify any
// OTHER logged-in session for this same account that a meeting just
// started. This is the ONLY mobile-side change this feature requires —
// mobile itself does not open any new sync socket and is otherwise
// unaffected (it remains the sole session with the "End Meeting" control,
// enforced server-side via owner_session_id, not by anything client-side
// here). Web's createMeeting() (app/web/src/lib/api.ts) intentionally does
// NOT send this field, so it defaults server-side to 'web' — v1 scope is
// mobile-origin sync only, per this task's explicit instructions.
//
// (2026-08-10) `channel` param added — the pre-record meeting-setup step
// (meeting-setup.tsx) now collects an explicit In-Person/Over-the-Phone
// choice from the user BEFORE this is called, and passes it straight
// through here so the existing `meetings.channel` column (see Meeting.channel
// doc above) is set from the user's real choice instead of always falling
// through to its 'in_person' DB default. Optional + defaults to 'in_person'
// server-side (see server.js) so this remains backwards compatible with any
// other caller that doesn't pass it.
export async function createMeeting(customerId?: string, channel?: MeetingChannel): Promise<Meeting> {
  return request('POST', '/api/meetings', {
    customer_id: customerId,
    origin_client: 'mobile',
    channel,
  });
}

// 2026-08-07: GET /api/meetings now returns a paginated
// { meetings, hasMore, limit, offset } envelope (see aria-web's
// pagination pass in server.js + app/web/src/lib/api.ts) instead of a
// bare array. Mobile's history screen ((tabs)/index.tsx) is out of scope
// for adding pagination UI in that same pass, but must not break against
// the now-shared backend contract — this just unwraps `.meetings` and
// keeps mobile's existing "show what the server gives us" behavior
// (first page, i.e. the most recent `limit` meetings) unchanged.
export async function listMeetings(): Promise<Meeting[]> {
  const page = await request<{ meetings: Meeting[] }>('GET', '/api/meetings');
  return page.meetings;
}

export async function getMeeting(id: string): Promise<Meeting> {
  return request('GET', `/api/meetings/${id}`);
}

export async function updateMeeting(
  id: string,
  data: Partial<Pick<Meeting, 'status' | 'ended_at' | 'summary' | 'title' | 'speaker_labels'>>
): Promise<Meeting> {
  return request('PATCH', `/api/meetings/${id}`, data);
}

// ─── Transcript segments (2026-08-04, bottom-nav / meeting history) ────────
// Mirrors app/web/src/lib/api.ts's getMeetingSegments() — same existing
// backend contract (GET /api/meetings/:id/segments), not a new endpoint.
// Used by the new Home-tab "previous transcripts" history/detail screens.

export interface TranscriptSegment {
  speaker: string;
  text: string;
  ts: string;
}

export async function getMeetingSegments(id: string): Promise<{ segments: TranscriptSegment[] }> {
  return request('GET', `/api/meetings/${id}/segments`);
}

// ─── Summary generation (2026-08-04, mobile/web save-parity fix) ──────────
// Mirrors app/web/src/pages/MeetingPage.tsx's handleGenerateSummary(): a
// manual, user-initiated call to the EXISTING POST /api/meetings/:id/summary
// endpoint. Web does NOT auto-generate a summary when a meeting ends either —
// the rep taps a "Generate Summary" button in the post-meeting view. Mobile
// previously had no UI path to reach this endpoint at all, so a mobile
// meeting's summary stayed null forever even though its transcript persisted
// correctly (same backend WS code path as web). This restores parity with
// web's existing (manual) behavior — it does NOT make summary generation
// automatic on every mobile meeting-end, which would add an unconditional
// Anthropic API cost per call and diverge from web's own UX.
export async function generateSummary(id: string): Promise<{ summary: string }> {
  return request('POST', `/api/meetings/${id}/summary`, {});
}
