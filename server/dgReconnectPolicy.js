/**
 * dgReconnectPolicy.js — shared Deepgram reconnect timing/lapse-tracking
 * policy, used by BOTH server.js's in-person `/meetings/:id/audio` handler
 * and deepgramSession.js (Aria Phone Channel). Pure bookkeeping/timing only
 * — no socket I/O, no knowledge of WebSocket/Deepgram at all — so it can be
 * unit tested standalone (see server/test/dgReconnectPolicy.test.mjs) and
 * shared without violating the "don't touch/refactor the working in-person
 * connection lifecycle" constraint: the two call sites keep their own
 * separate WebSocket plumbing and their own separate connect()/close()
 * implementations; only the reconnect-delay math and lapse-notice
 * bookkeeping are unified here, because that is exactly the part this task
 * asked to harden identically in both places (jittered backoff + a real
 * time budget + a >2s lapse notice + a recovery notice), and duplicating
 * THAT by hand in two files is how the two paths would drift out of sync
 * on the next tuning pass.
 *
 * 2026-08-18 hardening (this pass) — root causes from the 8/4 and 8/9
 * outages: an unbounded, no-jitter reconnect loop that could keep retrying
 * for the life of the process and, with many concurrent meetings, retries
 * synchronized in lockstep (same base delay, same attempt count, same wall
 * clock) into a stampede against a single backend replica. Fixes:
 *   1. Exponential backoff WITH jitter (mandatory — see stampede note
 *      above): 250ms -> 500ms -> 1s -> 2s -> 4s -> 8s ceiling, each value
 *      randomized to 50%-150% of the nominal exponential value so
 *      concurrent meetings' retries spread out instead of syncing up.
 *   2. A real elapsed-time budget (~60s, env-tunable via
 *      DG_RECONNECT_BUDGET_MS) is now the PRIMARY stop condition — once a
 *      single lapse (continuous disconnected period) has been retrying for
 *      that long, give up for THIS session only and mark it degraded.
 *   3. A secondary hard attempt ceiling (~10, env-tunable via
 *      DG_RECONNECT_MAX_ATTEMPTS) remains as a seatbelt in case the backoff
 *      math ever produces more attempts than the budget should allow (e.g.
 *      a clock issue) — the time budget is what actually protects prod,
 *      the attempt count is a backstop, not the primary control.
 *   4. A >2s lapse produces a "lapse start" notice (so the rep sees a
 *      connection problem, not a silent gap) and a matching "lapse end"
 *      notice on recovery with the observed duration. Sessions that never
 *      recover within 2s never got a notice under the old code — the old
 *      circuit breaker only ever spoke up once the ENTIRE breaker tripped
 *      (up to 8 failures across a 5-minute window, i.e. minutes of silent
 *      dead air), not the first user-perceptible stall.
 *
 * Failure/give-up scope: an instance of `createReconnectTracker()` is
 * per-connection (per-meeting for the in-person handler, per-call for the
 * phone handler). Nothing here is global/process-wide — the caller creates
 * one tracker per session and disposes it when that session ends, exactly
 * like the old per-connection reconnectAttempts/circuitOpen state it
 * replaces. One bad stream giving up never touches any other session's
 * tracker or timers.
 */

export const DG_RECONNECT_BASE_MS = Number(process.env.DG_RECONNECT_BASE_MS) || 250;
export const DG_RECONNECT_MAX_MS = Number(process.env.DG_RECONNECT_MAX_MS) || 8000;
export const DG_RECONNECT_BUDGET_MS = Number(process.env.DG_RECONNECT_BUDGET_MS) || 60000;
// 2026-08-18: the brief's stated target was "~10" as a pure seatbelt with
// the 60s budget as the PRIMARY control. The actual backoff math doesn't
// support that at 10: nominal cumulative delay time (250,500,1s,2s,4s,8s,
// 8s,8s,...) crosses 60s between attempt 11 and 12, so a ceiling of 10
// fires FIRST in nearly all real runs (verified: 50/50 simulated trials hit
// the attempt ceiling, average ~41s elapsed, never the time budget) — that
// would make the attempt ceiling the de facto primary control, backwards
// from the design intent. Raised to 14 so the ceiling sits comfortably
// past where the budget is expected to fire (~attempt 11-12) and only acts
// as a true backstop if the backoff math misbehaves, while still being a
// hard, real ceiling rather than an arbitrarily large number. See
// server/test/dgReconnectPolicy.test.mjs for the timing proof.
export const DG_RECONNECT_MAX_ATTEMPTS = Number(process.env.DG_RECONNECT_MAX_ATTEMPTS) || 14;
export const DG_LAPSE_NOTICE_THRESHOLD_MS = Number(process.env.DG_LAPSE_NOTICE_THRESHOLD_MS) || 2000;

/**
 * Nominal (pre-jitter) exponential delay for the given zero-indexed attempt
 * number: 250ms, 500ms, 1s, 2s, 4s, 8s, 8s, 8s, ... (capped at
 * DG_RECONNECT_MAX_MS from then on).
 */
export function nominalDelayMs(attemptIndex) {
  return Math.min(DG_RECONNECT_BASE_MS * Math.pow(2, attemptIndex), DG_RECONNECT_MAX_MS);
}

/**
 * Jittered delay for the given zero-indexed attempt number. Full-jitter-ish:
 * uniformly random in [50%, 150%] of the nominal exponential value, floored
 * at DG_RECONNECT_BASE_MS so we never busy-loop at ~0ms. This is what makes
 * many concurrent meetings' reconnects spread out in time instead of
 * retrying in lockstep (see module header, stampede note).
 *
 * @param {() => number} [rng] — injectable RNG for deterministic tests.
 */
export function nextReconnectDelayMs(attemptIndex, rng = Math.random) {
  const nominal = nominalDelayMs(attemptIndex);
  const jittered = nominal * (0.5 + rng());
  // Floor is a busy-loop guard only (avoid a near-0ms delay if rng() were
  // ever exactly 0 on the smallest nominal tier) — deliberately much lower
  // than DG_RECONNECT_BASE_MS itself so the jitter band at the smallest
  // tier (nominal 250ms -> [125ms, 375ms]) isn't clamped/clipped back into
  // a cluster at the floor, which would defeat the anti-stampede purpose
  // of jitter at exactly the tier where concurrent-meeting synchronization
  // is most likely (the first retry after a shared outage).
  return Math.max(50, Math.round(jittered));
}

/**
 * Tracks a single connection's reconnect lifecycle: jittered backoff delay
 * sequencing, the 60s time budget + 10-attempt seatbelt give-up
 * conditions, and >2s lapse-start / lapse-end notices. Does NOT open or
 * close any socket itself — callers drive it from their own
 * WebSocket 'close'/'open' handlers and act on the returned instructions.
 *
 * @param {object} opts
 * @param {(startedAtMs: number) => void} [opts.onLapseStart] — fires once,
 *   ONLY if the connection is still down DG_LAPSE_NOTICE_THRESHOLD_MS after
 *   it dropped (a blip that recovers within 2s never fires this).
 * @param {(durationMs: number) => void} [opts.onLapseEnd] — fires once,
 *   ONLY if onLapseStart previously fired for this lapse, when the
 *   connection comes back. Never fires for a sub-2s blip (nothing to
 *   "end" that was never announced as started).
 * @param {(reason: string) => void} [opts.onGiveUp] — fires once when
 *   either the time budget or the attempt ceiling is hit; caller should
 *   stop reconnecting and mark this session's transcription degraded.
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.now] — injectable clock for tests.
 * @param {() => number} [opts.rng] — injectable RNG for tests.
 */
export function createReconnectTracker({ onLapseStart, onLapseEnd, onGiveUp, log, now = Date.now, rng = Math.random } = {}) {
  const logFn = log || (() => {});
  let attempts = 0;
  let lapseStartedAt = null; // wall-clock ms when the CURRENT lapse began, or null if connected
  let noticeTimer = null;
  let noticeSent = false;
  let givenUp = false;

  function armNoticeTimer() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (lapseStartedAt !== null && !noticeSent && !givenUp) {
        noticeSent = true;
        try { onLapseStart && onLapseStart(lapseStartedAt); } catch (e) { logFn(`onLapseStart handler threw: ${e.message}`); }
      }
    }, DG_LAPSE_NOTICE_THRESHOLD_MS);
  }

  /**
   * Call this from the underlying socket's 'close'/error path, once per
   * disconnect. Returns either `{ delayMs }` (schedule the next connect
   * attempt after delayMs) or `{ giveUp: true, reason }` (stop retrying —
   * this session's transcription is now degraded).
   */
  function onDisconnect() {
    if (givenUp) return { giveUp: true, reason: 'already given up for this session' };

    if (lapseStartedAt === null) {
      lapseStartedAt = now();
      noticeSent = false;
      armNoticeTimer();
    }

    attempts += 1;
    const elapsed = now() - lapseStartedAt;

    if (elapsed >= DG_RECONNECT_BUDGET_MS) {
      return giveUp(`reconnect time budget exhausted (${Math.round(elapsed / 1000)}s >= ${DG_RECONNECT_BUDGET_MS / 1000}s budget)`);
    }
    if (attempts >= DG_RECONNECT_MAX_ATTEMPTS) {
      return giveUp(`reconnect attempt ceiling reached (${attempts} >= ${DG_RECONNECT_MAX_ATTEMPTS} attempts)`);
    }

    return { delayMs: nextReconnectDelayMs(attempts - 1, rng) };
  }

  function giveUp(reason) {
    givenUp = true;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    logFn(`reconnect tracker: giving up — ${reason}`);
    try { onGiveUp && onGiveUp(reason); } catch (e) { logFn(`onGiveUp handler threw: ${e.message}`); }
    return { giveUp: true, reason };
  }

  /** Call this from the underlying socket's 'open' (successful connect) handler. */
  function onConnected() {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (lapseStartedAt !== null) {
      const durationMs = now() - lapseStartedAt;
      const wasNoticed = noticeSent;
      lapseStartedAt = null;
      noticeSent = false;
      attempts = 0;
      if (wasNoticed) {
        try { onLapseEnd && onLapseEnd(durationMs); } catch (e) { logFn(`onLapseEnd handler threw: ${e.message}`); }
      }
    } else {
      attempts = 0;
    }
  }

  /** True once this tracker has given up (budget or attempt ceiling hit). */
  function isGivenUp() {
    return givenUp;
  }

  /** Stop any pending timers without emitting a giveUp/lapseEnd notice — for a clean, intentional close (e.g. the client hung up), not a failure. */
  function dispose() {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  }

  return { onDisconnect, onConnected, isGivenUp, dispose };
}
