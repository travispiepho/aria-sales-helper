/**
 * readinessTracker.js — turns the raw event-loop-lag *sample* that
 * server.js already takes every EVENT_LOOP_SAMPLE_MS into a debounced,
 * anti-flap READY/NOT-READY signal for the separate GET /ready endpoint.
 *
 * Why this exists (2026-08-18, part (b) of the Aug 9 incident hardening):
 * /health reports `eventLoop.status: 'degraded'` the instant ONE sample
 * exceeds EVENT_LOOP_LAG_DEGRADED_MS, but nothing acted on that — it was a
 * visible number, not a signal anything could safely act on. A raw
 * threshold crossing is too noisy to act on directly: a single GC pause or
 * one heavy transcript-processing tick can push lag over 1000ms for one
 * sample and then immediately recover. Flipping a readiness/LB signal on
 * that would flap constantly and would be worse than useless for anything
 * consuming it (routing, alerting).
 *
 * This module is pure bookkeeping — no I/O, no timers of its own, no
 * knowledge of HTTP or the event loop. The caller (server.js) feeds it one
 * boolean per sample from the SAME sampler that already runs (piggy-backed
 * on the existing setInterval, not a new poll loop), which is what keeps
 * this signal cheap per requirement (5) in the brief: computing "is this
 * boolean true for long enough" costs a couple of Date.now()/subtraction
 * ops per 500ms tick, nothing more.
 *
 * Design mirrors dgReconnectPolicy.js: named, env-tunable constants; an
 * injectable clock for deterministic tests; explicit reasoning in comments
 * instead of a stale comment nobody reads later.
 */

// How long event-loop lag must stay ABOVE EVENT_LOOP_LAG_DEGRADED_MS,
// with NO healthy sample in between, before /ready flips to 503.
//
// Sample cadence is EVENT_LOOP_SAMPLE_MS (500ms in server.js), so 10000ms
// is ~20 consecutive degraded samples. Rationale: EVENT_LOOP_LAG_DEGRADED_MS
// (1000ms) is already a severe threshold — normal GC pauses and single
// heavy audio-processing ticks recover within one or two sample windows
// (well under 2s). Requiring 10s of UNBROKEN degradation means only a
// genuinely wedged or sustained-overload loop trips this, not a blip.
// This is deliberately longer than DG_LAPSE_NOTICE_THRESHOLD_MS (2000ms)
// used for Deepgram lapse notices, because that's a per-call transcript
// user-experience signal (users notice a 2s gap); this is an infra
// readiness signal meant to gate on sustained system-level trouble, not a
// momentary user-visible blip, so it can and should tolerate more transient
// noise before acting.
const READINESS_DEGRADED_SUSTAIN_MS = Number(process.env.READINESS_DEGRADED_SUSTAIN_MS) || 10000;

// How long event-loop lag must stay AT/BELOW the threshold, with no
// degraded sample in between, before /ready flips back to 200 after having
// been unready.
//
// Deliberately shorter than the degrade-sustain window (5s vs 10s): the
// cost of staying falsely reported as "not ready" a bit longer than
// strictly necessary is low (in the current single-replica reality nothing
// is routing around a "not ready" reader/LB member anyway, so a slightly
// slow recovery report costs nothing operationally); the cost of flapping
// or under-reacting to real degradation is not. So we bias the asymmetry
// toward being slow to clear rather than slow to raise, without making
// recovery so short that a marginal, wobbling loop (repeatedly dipping
// just above/below threshold) flip-flops the signal.
const READINESS_RECOVERY_SUSTAIN_MS = Number(process.env.READINESS_RECOVERY_SUSTAIN_MS) || 5000;

// Deliberately NOT factoring active meeting count into the readiness
// decision. Considered and rejected for now:
//   - The brief's own framing (EVENT_LOOP_SAMPLE_MS block above) is that a
//     busy box under legitimate multi-meeting load is EXACTLY when this
//     signal needs to fire, not be suppressed — that busy-but-working state
//     is the precise precursor to the 502 condition from the Aug 9
//     incident. Discounting lag because activeMeetings is high would blind
//     the signal to the case it exists to catch.
//   - There is currently only one replica (part (a), a second replica, is
//     on hold). With one replica there is nowhere to route "around" this
//     instance even if /ready did factor in load, so a load-aware
//     adjustment would add complexity with no operational payoff yet.
//   - If/when a second replica exists, activeMeetings-aware behavior would
//     make more sense on the LOAD BALANCER side (route new meetings away
//     from a high-count instance) rather than baked into this process's
//     own readiness math — that's a different, later decision, not a
//     change to make here.
// If this needs revisiting, the raw count is already exposed on /health as
// `activeMeetings` and cheap to read from a future consumer.

/**
 * Creates a readiness state machine. Call `sample(degradedNow)` once per
 * lag-sampler tick with whatever boolean server.js already computed
 * (`eventLoopLagMs > EVENT_LOOP_LAG_DEGRADED_MS`). Call `isReady()` from the
 * /ready handler to read current state without recomputing anything.
 *
 * State machine (duration-since-first-opposite-sample, reset by ANY sample
 * of the current stable type — this is what gives both "consecutive
 * samples" and "duration" anti-flap properties from the brief at once: a
 * single healthy sample resets the not-ready deadline back to zero, and a
 * single degraded sample resets the ready deadline back to zero):
 *
 *   ready=true,  sample=degraded -> start/continue a "going unready" timer;
 *                                    flip to ready=false once it has run
 *                                    uninterrupted for READINESS_DEGRADED_SUSTAIN_MS.
 *   ready=true,  sample=healthy  -> cancel any "going unready" timer.
 *   ready=false, sample=healthy  -> start/continue a "recovering" timer;
 *                                    flip to ready=true once it has run
 *                                    uninterrupted for READINESS_RECOVERY_SUSTAIN_MS.
 *   ready=false, sample=degraded -> cancel any "recovering" timer.
 *
 * @param {object} [opts]
 * @param {number} [opts.degradedSustainMs]
 * @param {number} [opts.recoverySustainMs]
 * @param {() => number} [opts.now] — injectable clock for tests.
 * @param {(msg: string) => void} [opts.log]
 */
export function createReadinessTracker({
  degradedSustainMs = READINESS_DEGRADED_SUSTAIN_MS,
  recoverySustainMs = READINESS_RECOVERY_SUSTAIN_MS,
  now = Date.now,
  log,
} = {}) {
  const logFn = log || (() => {});
  let ready = true;
  let candidateSince = null; // wall-clock ms when the current run of opposite-type samples began, or null
  let lastTransitionAt = null;
  let lastTransitionReason = null;

  function sample(degradedNow) {
    const t = now();
    if (ready) {
      if (degradedNow) {
        if (candidateSince === null) candidateSince = t;
        if (t - candidateSince >= degradedSustainMs) {
          ready = false;
          lastTransitionAt = t;
          lastTransitionReason = `event-loop lag sustained degraded for >=${degradedSustainMs}ms`;
          logFn(`readiness: flipping NOT READY — ${lastTransitionReason}`);
          candidateSince = null;
        }
      } else {
        candidateSince = null;
      }
    } else {
      if (!degradedNow) {
        if (candidateSince === null) candidateSince = t;
        if (t - candidateSince >= recoverySustainMs) {
          ready = true;
          lastTransitionAt = t;
          lastTransitionReason = `event-loop lag recovered and stayed healthy for >=${recoverySustainMs}ms`;
          logFn(`readiness: flipping READY — ${lastTransitionReason}`);
          candidateSince = null;
        }
      } else {
        candidateSince = null;
      }
    }
    return ready;
  }

  function isReady() {
    return ready;
  }

  function getState() {
    return {
      ready,
      degradedSustainMs,
      recoverySustainMs,
      pendingSinceMs: candidateSince,
      lastTransitionAt,
      lastTransitionReason,
    };
  }

  return { sample, isReady, getState };
}

export { READINESS_DEGRADED_SUSTAIN_MS, READINESS_RECOVERY_SUSTAIN_MS };
