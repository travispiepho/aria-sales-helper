// meetingRetention.js
//
// Context (per Gabe, 2026-08-30): "Any scheduled meetings should persist an
// extra 24 hours just in case there are any problems. Do not despawn them
// until 24 hours after the logged meeting time OR if the meeting was
// started and finished."
//
// INVESTIGATION FINDING (2026-08-30, aria_meeting_despawn_24h_retention):
// This codebase currently has NO automatic, time-based deletion/expiry of
// `meetings` rows. The only code path that removes a meeting row at all is
// the explicit, user-initiated `DELETE /api/meetings/:id` route in
// server.js (a rep or admin deliberately deleting one specific meeting they
// have access to) — there is no cron job, `setInterval`-driven sweep, TTL
// column, or garbage-collector anywhere in server/ that prunes meetings by
// age. (`finalizeMeetingIfAbandoned()` / `ABANDONED_MEETING_GRACE_MS` in
// server.js is a different, unrelated mechanism: it flips a still-`active`
// meeting's `status` to `'interrupted'` ~20s after its audio WebSocket
// disconnects with no reconnect — it never deletes a row.)
//
// So this module is NOT a bugfix for an existing auto-deletion bug — it is
// a preventive guard, ready for any FUTURE cleanup/retention job (e.g. a
// storage-cost-driven pruning pass) to call before it deletes a meeting
// row, so that future work respects Gabe's rule from day one instead of
// needing to rediscover it. Nothing in production currently calls this
// function destructively; it is deliberately dormant until such a cleanup
// path exists. `DELETE /api/meetings/:id` is a single, explicit,
// human-initiated action on one meeting the caller already has access to —
// it is intentionally NOT gated by this guard, the same way "empty trash"
// staying available to a user doesn't get blocked by a 24h data-retention
// policy meant for *automatic* sweeps.
//
// SCHEMA NOTE — what "logged meeting time" means in this schema:
// `meetings.started_at` already serves double duty here (see
// scheduledMeetings.js): for an ordinary (non-scheduled) meeting it's set
// to `NOW()` at creation, i.e. the real start time. For a meeting created
// via the schedule-ahead flow (`scheduled_for` is set) that HAS NOT yet
// been started, `started_at` is seeded with `scheduled_for` itself (see the
// INSERT in scheduledMeetings.js) — so `started_at` is exactly the "logged
// meeting time" Gabe means in both cases: the actual start for a live/past
// meeting, or the scheduled start for one still upcoming. No new column is
// needed to express this rule.
//
// "Started": for a schedule-ahead meeting, the app already has an explicit
// flag for this — `scheduled_started_at` is null until the rep actually
// taps to begin it (see `POST /api/scheduled-meetings/:id/start`). A
// meeting with no `scheduled_for` at all (created the normal, immediate
// way) is considered started the moment it exists, since there is no
// "scheduled but not yet begun" state for it.
//
// "Finished": the meeting has left `'active'` and reached a terminal
// status (`'completed'`, `'cancelled'`, or `'interrupted'`).
//
// OR vs AND (flagged, not silently resolved): Gabe's sentence — "Do not
// despawn them until 24 hours after the logged meeting time OR if the
// meeting was started and finished" — reads most naturally as an OR: EITHER
// condition alone (24h elapsed, OR started-and-finished) is sufficient to
// permit despawn. That is what this module implements. The alternative
// reading (an AND — always require both, i.e. a finished meeting still
// must sit for the full 24h) is also plausible given the surrounding
// "just in case there are any problems" framing, which arguably applies
// even to a cleanly finished meeting. Implemented as the literal OR below;
// flag for Gabe/Troy sign-off if the intent was actually the stricter AND.
//
// A meeting that was scheduled but CANCELLED before ever being started
// (`scheduled_started_at` still null) does NOT qualify for the
// started-and-finished exemption under this literal reading — it was never
// "started" — so it still needs the full 24h from its `scheduled_for` time
// before a future cleanup job could remove it. This falls directly out of
// applying the rule as written; called out here in case that specific edge
// case should behave differently.

const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'interrupted']);

/**
 * Has this meeting actually been started (as opposed to merely scheduled
 * and still upcoming)?
 */
function isStarted(meeting) {
  if (!meeting.scheduled_for) return true; // no schedule-ahead flow involved
  return meeting.scheduled_started_at != null;
}

/** Has this meeting reached a terminal (non-`'active'`) status? */
function isFinished(meeting) {
  return TERMINAL_STATUSES.has(meeting.status);
}

/**
 * The "logged meeting time" a despawn/retention decision should be measured
 * against: the actual start for a live/past meeting, or the scheduled start
 * for one that hasn't begun yet (see schema note above — both live in
 * `started_at`).
 */
function loggedMeetingTime(meeting) {
  return meeting.started_at ? new Date(meeting.started_at) : null;
}

/**
 * Guard for any future automatic meeting cleanup/despawn job. Returns
 * `true` only when it is safe to remove `meeting`, per Gabe's rule:
 * despawn is allowed once 24 hours have passed since the logged meeting
 * time, OR once the meeting was both started and finished — whichever
 * comes first (see OR-vs-AND note above).
 *
 * This does NOT gate the existing, explicit `DELETE /api/meetings/:id`
 * route (a human deliberately deleting one meeting they own) — only
 * intended for use by future automatic/bulk cleanup logic.
 *
 * @param {object} meeting - a `meetings` row (or the subset of fields:
 *   `status`, `started_at`, `scheduled_for`, `scheduled_started_at`).
 * @param {object} [options]
 * @param {Date|number} [options.now] - clock override for tests.
 * @returns {boolean}
 */
function canDespawnMeeting(meeting, options = {}) {
  if (!meeting) return false;
  const now = options.now instanceof Date ? options.now
    : options.now != null ? new Date(options.now)
    : new Date();

  if (isStarted(meeting) && isFinished(meeting)) return true;

  const loggedAt = loggedMeetingTime(meeting);
  if (!loggedAt || Number.isNaN(loggedAt.getTime())) return false; // no timestamp to measure against — don't despawn
  return now.getTime() - loggedAt.getTime() >= RETENTION_WINDOW_MS;
}

export {
  RETENTION_WINDOW_MS,
  TERMINAL_STATUSES,
  isStarted,
  isFinished,
  loggedMeetingTime,
  canDespawnMeeting,
};
