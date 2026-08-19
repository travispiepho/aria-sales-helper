/**
 * reconnectPolicy.ts — client-side port of server/dgReconnectPolicy.js's
 * jittered-backoff + time-budget + lapse-notice math, for the web PWA's own
 * /meetings/:id/audio WebSocket reconnect loop.
 *
 * 2026-08-18 hardening (this pass): the web client's own reconnect loop
 * (MeetingPage.tsx's connectWebSocket/ws.onclose) previously used a
 * no-jitter 1s→10s backoff with no time budget or attempt ceiling at all —
 * it would retry forever while isRecordingRef.current stayed true. This is
 * a SEPARATE reconnect loop from the server's own Deepgram reconnect
 * (server/dgReconnectPolicy.js), but the same design applies: jitter
 * matters here too (many reps' browser tabs reconnecting to a recovering
 * backend at the same instant is the same stampede shape, just client-side
 * instead of server-side), and a real time budget means the client stops
 * retrying and shows an unambiguous "live transcription stopped" state
 * instead of spinning the 'reconnecting' pill forever.
 *
 * CRITICAL — this file is intentionally NOT shared/imported from
 * server/dgReconnectPolicy.js (different runtime: browser vs. Node ESM
 * import resolution, no bundler-shared workspace package configured for
 * this repo) — this is a deliberate, minimal duplication of just the
 * timing math, same class of accepted debt as deepgramSession.js's own
 * duplication note re: server.js's in-person handler.
 *
 * Numbers match the server's shared policy exactly (250ms→8s jittered,
 * ~60s budget, ~14-attempt seatbelt, 2s lapse-notice threshold) so a rep's
 * experience is consistent regardless of which side detects a given lapse
 * first (see MeetingPage.tsx's pushLapseStartNotice/pushLapseEndNotice for
 * the client+server dedup).
 */

export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 8000;
export const RECONNECT_BUDGET_MS = 60000;
export const RECONNECT_MAX_ATTEMPTS = 14;
export const LAPSE_NOTICE_THRESHOLD_MS = 2000;

export function nominalDelayMs(attemptIndex: number): number {
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, attemptIndex), RECONNECT_MAX_MS);
}

export function nextReconnectDelayMs(attemptIndex: number, rng: () => number = Math.random): number {
  const nominal = nominalDelayMs(attemptIndex);
  const jittered = nominal * (0.5 + rng());
  return Math.max(50, Math.round(jittered));
}

export interface ReconnectTrackerCallbacks {
  onLapseStart?: (startedAtMs: number) => void;
  onLapseEnd?: (durationMs: number) => void;
  onGiveUp?: (reason: string) => void;
}

export interface ReconnectTracker {
  onDisconnect: () => { delayMs: number } | { giveUp: true; reason: string };
  onConnected: () => void;
  isGivenUp: () => boolean;
  dispose: () => void;
}

/** Client-side twin of server/dgReconnectPolicy.js's createReconnectTracker — see that module's header for the full contract/rationale. */
export function createReconnectTracker(
  { onLapseStart, onLapseEnd, onGiveUp }: ReconnectTrackerCallbacks,
  now: () => number = Date.now,
  rng: () => number = Math.random
): ReconnectTracker {
  let attempts = 0;
  let lapseStartedAt: number | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeSent = false;
  let givenUp = false;

  function armNoticeTimer() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (lapseStartedAt !== null && !noticeSent && !givenUp) {
        noticeSent = true;
        onLapseStart?.(lapseStartedAt);
      }
    }, LAPSE_NOTICE_THRESHOLD_MS);
  }

  function giveUp(reason: string) {
    givenUp = true;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    onGiveUp?.(reason);
    return { giveUp: true as const, reason };
  }

  function onDisconnect() {
    if (givenUp) return giveUp('already given up for this session');

    if (lapseStartedAt === null) {
      lapseStartedAt = now();
      noticeSent = false;
      armNoticeTimer();
    }

    attempts += 1;
    const elapsed = now() - lapseStartedAt;

    if (elapsed >= RECONNECT_BUDGET_MS) {
      return giveUp(`reconnect time budget exhausted (${Math.round(elapsed / 1000)}s >= ${RECONNECT_BUDGET_MS / 1000}s budget)`);
    }
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      return giveUp(`reconnect attempt ceiling reached (${attempts} >= ${RECONNECT_MAX_ATTEMPTS} attempts)`);
    }

    return { delayMs: nextReconnectDelayMs(attempts - 1, rng) };
  }

  function onConnected() {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (lapseStartedAt !== null) {
      const durationMs = now() - lapseStartedAt;
      const wasNoticed = noticeSent;
      lapseStartedAt = null;
      noticeSent = false;
      attempts = 0;
      if (wasNoticed) onLapseEnd?.(durationMs);
    } else {
      attempts = 0;
    }
  }

  function isGivenUp() {
    return givenUp;
  }

  function dispose() {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  }

  return { onDisconnect, onConnected, isGivenUp, dispose };
}
