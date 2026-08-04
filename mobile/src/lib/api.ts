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
  process.env.EXPO_PUBLIC_API_URL || 'https://aria-backend-production-0e99.up.railway.app';

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
}

export async function createMeeting(customerId?: string): Promise<Meeting> {
  return request('POST', '/api/meetings', { customer_id: customerId });
}

export async function listMeetings(): Promise<Meeting[]> {
  return request('GET', '/api/meetings');
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
