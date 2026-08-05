/**
 * wsBase.ts — shared WS base-URL derivation.
 *
 * 2026-08-05 (live meeting sync, mobile → web): extracted from the
 * pre-existing local `getWsBase()` in MeetingPage.tsx (NOT modified there,
 * to avoid touching a file another concurrent task was also editing today
 * — see this task's report) so the new sync hook/dialog can share the exact
 * same derivation logic without duplicating it a second time or importing
 * a page component's internals. Identical behavior to MeetingPage.tsx's
 * copy: VITE_API_URL in production, current-origin-relative :3000 in dev.
 */

export function getWsBase(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    return apiUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://localhost:3000`;
}
