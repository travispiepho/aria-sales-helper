/**
 * reconnectPolicy.ts — mobile port of web/src/lib/reconnectPolicy.ts's
 * jittered-backoff + time-budget + lapse-notice math, for this screen's own
 * /meetings/:id/audio WebSocket reconnect loop (meeting.tsx).
 *
 * 2026-08-18 hardening (this pass): replaces the previous no-jitter 1s→10s
 * backoff + flat 8-attempt ceiling in meeting.tsx with the same shared
 * design used server-side (server/dgReconnectPolicy.js) and on web
 * (web/src/lib/reconnectPolicy.ts): 250ms→8s jittered exponential backoff,
 * a ~60s time budget as the PRIMARY give-up control, and a ~14-attempt
 * seatbelt as a backstop only — plus >2s lapse-start / recovery notices so
 * a dropped connection is visible in the transcript instead of just the
 * existing 'reconnecting' stage pill.
 *
 * INTENTIONAL DUPLICATION, not an oversight: this is a separate Expo/RN
 * package from app/web (no shared workspace package configured for this
 * repo), same accepted-debt pattern as server/deepgramSession.js's own
 * duplication note re: server.js. Numbers are kept identical to the web
 * and server versions on purpose so a rep's experience is consistent
 * regardless of platform/detection path.
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

/** Mobile twin of server/dgReconnectPolicy.js's createReconnectTracker — see that module's header for the full contract/rationale. */
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
