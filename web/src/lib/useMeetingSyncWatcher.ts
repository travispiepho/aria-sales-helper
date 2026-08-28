/**
 * useMeetingSyncWatcher.ts — Live meeting sync (mobile → web), full-page
 * rebuild, 2026-08-05 (replaces the earlier same-day popup implementation
 * — see MeetingSyncWatcher.tsx's file header for why, and MeetingPage.tsx
 * for the actual observer rendering).
 *
 * NEW REQUIREMENT (Gabe, verbatim, replacing the earlier popup approach):
 * "Instead of a popup, I would like an almost identical page to when you
 * are in a meeting started on aria-web that has all of the same features.
 * It should pretty much act like a meeting started on aria-web with the
 * only difference being the live transcript is coming from the phone
 * instead."
 *
 * SCOPE CHANGE FROM THE ORIGINAL useMeetingSync.ts: this hook now does
 * EXACTLY ONE thing — detect "a mobile-originated meeting is active for my
 * account" and navigate this web session to that meeting's normal
 * /meetings/:id route, the SAME route/component a web-started meeting
 * uses. It carries NO transcript/coaching/segment state anymore — that
 * entire responsibility moved into MeetingPage.tsx itself, which now reads
 * live data from GET /meetings/:id/observe for a non-owner session using
 * the exact same message-handling code path it already used for its own
 * GET /meetings/:id/audio connection (see MeetingPage.tsx's
 * `applyLiveMessage()` — one function, two socket sources, not two parallel
 * UIs to keep in sync by hand). This hook has nothing to render (no
 * component), it's a pure navigation trigger.
 *
 * ARCHITECTURE (unchanged from the original popup version — still the
 * right design, only the "what happens when we learn about a meeting"
 * action changed from "open a dialog" to "navigate"):
 *   - Primary: GET /api/sync, one WS per logged-in web session, pushes
 *     `meeting_started` the instant a mobile-originated POST /api/meetings
 *     happens for this user_id, and `meeting_ended` when it's finalized.
 *   - Fallback: GET /api/meetings/active-sync polled every 20s, only while
 *     this hook doesn't already know about an active synced meeting AND
 *     the WS isn't confirmed open — same reasoning as before (mount-time
 *     gap, dropped/reconnecting WS, defense in depth).
 *
 * NAVIGATION RULE: only calls navigate() if the browser isn't ALREADY on
 * that meeting's own page (a no-op is preferable to a same-target
 * re-navigation loop), and does not try to be smarter than that — per a
 * literal reading of "act like a meeting started on aria-web" (starting a
 * meeting on aria-web unconditionally navigates you to it), this hook
 * unconditionally navigates the tab to the synced meeting regardless of
 * what page it was previously showing. OPEN QUESTION carried over from the
 * original popup task and still unresolved here (flagged in this task's
 * report too): if a rep is mid-task on the Home/Profile page when their
 * phone starts a meeting, this will pull them away from it. That matches
 * Troy's original "on all instances" requirement's spirit (the popup did
 * the same — it appeared over whatever page they were on); a future pass
 * could add a dismiss/snooze affordance if that turns out to be too
 * aggressive in practice.
 */

import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getActiveSyncMeeting } from './api';
import { getWsBase } from './wsBase';
import { inRecordingPath } from './meetingRoutes';

const ACTIVE_SYNC_POLL_MS = 20_000;

export function useMeetingSyncWatcher() {
  const navigate = useNavigate();
  const location = useLocation();

  // Refs, not state — this hook renders nothing, so there is no UI to
  // re-render for; refs just need to stay current across the WS/poll
  // callbacks' closures.
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  const wsRef = useRef<WebSocket | null>(null);
  const wsOpenRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the last meeting id we've already navigated to/for, so a
  // duplicate meeting_started push (e.g. WS catch-up racing the REST
  // fallback) doesn't fire a second redundant navigate() call.
  const lastNavigatedIdRef = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;

    function goToMeeting(meetingId: string) {
      if (lastNavigatedIdRef.current === meetingId && pathRef.current === inRecordingPath(meetingId)) {
        return;
      }
      lastNavigatedIdRef.current = meetingId;
      if (pathRef.current !== inRecordingPath(meetingId)) {
        navigate(inRecordingPath(meetingId));
      }
    }

    function connectAccountSync() {
      if (stopped) return;
      const ws = new WebSocket(`${getWsBase()}/api/sync`);
      wsRef.current = ws;

      ws.onopen = () => {
        wsOpenRef.current = true;
      };
      ws.onmessage = (evt) => {
        let msg: any;
        try {
          msg = JSON.parse(evt.data as string);
        } catch {
          return;
        }
        if (msg.type === 'meeting_started' && msg.meeting?.id) {
          goToMeeting(msg.meeting.id);
        } else if (msg.type === 'meeting_ended') {
          if (lastNavigatedIdRef.current === msg.meetingId) {
            lastNavigatedIdRef.current = null;
          }
        }
      };
      ws.onclose = () => {
        wsOpenRef.current = false;
        if (stopped) return;
        reconnectTimerRef.current = setTimeout(connectAccountSync, 5000);
      };
      ws.onerror = () => {
        // onclose fires right after; reconnect handled there.
      };
    }

    async function pollOnce() {
      try {
        const { active } = await getActiveSyncMeeting();
        if (active) goToMeeting(active.id);
      } catch {
        // Non-fatal — will retry next interval tick.
      }
    }

    connectAccountSync();
    pollOnce();
    pollTimerRef.current = setInterval(() => {
      if (!wsOpenRef.current) pollOnce();
    }, ACTIVE_SYNC_POLL_MS);

    return () => {
      stopped = true;
      wsRef.current?.close();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
