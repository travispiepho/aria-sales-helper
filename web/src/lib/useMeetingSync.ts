/**
 * useMeetingSync.ts — Live meeting sync (mobile → web), 2026-08-05
 *
 * Feature: ARIA Sales Helper — Live meeting sync: mobile-started meetings
 * visible (read-only) on web (Troy, verbatim): "I need to pull up a meeting
 * dialog on all instances that are logged into the account that is hosting
 * the meeting, but the meeting should only be able to be ended on the
 * device that started the meeting in the first place... Start with only
 * syncing meetings that START on MOBILE to web."
 *
 * v1 SCOPE (explicit): mobile → web only. This hook does NOT sync
 * web-started meetings to mobile — that reverse direction is a clear,
 * separate next step (see this task's final report for what it would take:
 * mobile would need its own GET /api/sync-equivalent connection + a native
 * "meeting in progress on your account" screen, which does not exist today).
 *
 * ARCHITECTURE (why WS-primary + short-poll fallback, not one or the
 * other):
 *   - Primary: a single, always-open GET /api/sync WebSocket per logged-in
 *     web session. The backend pushes `meeting_started` the instant a
 *     mobile-originated POST /api/meetings happens for this same user_id,
 *     and `meeting_ended` the instant that meeting is finalized (manual
 *     PATCH from the owning mobile device, OR the server's own abandoned-
 *     meeting auto-finalize if mobile disconnects and never reconnects —
 *     see server.js's finalizeMeetingIfAbandoned()). This is genuinely
 *     real-time — no polling delay for the common case.
 *   - Fallback: GET /api/meetings/active-sync is polled on a slow interval
 *     (20s) ONLY while this hook believes there's no active synced meeting
 *     AND the WS is not currently in the `open` readyState. This exists
 *     for: (a) the brief window between component mount and the WS
 *     handshake completing, (b) a dropped WS that hasn't reconnected yet
 *     (network blip, backend restart), and (c) defense-in-depth against any
 *     WS message class this hook doesn't yet handle. 20s was chosen as
 *     "fast enough that a rep won't wonder where the dialog is if they
 *     happen to load the page in the gap, slow enough to be a trivial REST
 *     load" — this is explicitly a fallback, not the primary mechanism, so
 *     it does not need to feel truly live on its own.
 *   - Once a meeting is known (from either path), a SECOND, per-meeting
 *     WebSocket (GET /meetings/:id/observe) is opened to receive the actual
 *     live transcript/coaching feed for the synced dialog — reusing the
 *     exact same message shapes (`interim`, `final`, `coaching`,
 *     `speaker_lock`, etc.) the owner's own /meetings/:id/audio connection
 *     already produces server-side (see server.js's broadcastToMeeting()),
 *     not a second parallel pipeline.
 *
 * OPEN QUESTION (flagged for Gabe/Troy, see report): if a user has this app
 * open in MULTIPLE web tabs, every tab independently opens its own
 * /api/sync and (once a meeting is known) /meetings/:id/observe socket —
 * so all tabs would show the synced dialog simultaneously. This matches a
 * literal reading of Troy's "on all instances that are logged into the
 * account" — but if the intent is actually "just one, wherever they look
 * next," that would need a leader-election/single-active-tab mechanism not
 * built here.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { getActiveSyncMeeting, type ActiveSyncMeeting } from './api';
import { getWsBase } from './wsBase';

export interface SyncTranscriptSegment {
  speaker: string;
  text: string;
  isFinal: boolean;
  ts?: number;
}

export interface SyncCoachingData {
  disc?: { emoji: string; label: string; tip: string };
  stage?: { label: string };
  checklist?: { id: string; label: string; done: boolean }[];
  nudges?: string[];
  urgent?: string | null;
}

export type SyncMeetingStatus = 'none' | 'active' | 'ended';

export interface MeetingSyncState {
  status: SyncMeetingStatus;
  meeting: ActiveSyncMeeting | null;
  segments: SyncTranscriptSegment[];
  interim: { speaker: string; text: string } | null;
  coaching: SyncCoachingData | null;
  dismissed: boolean;
  dismiss: () => void;
}

const ACTIVE_SYNC_POLL_MS = 20_000;

export function useMeetingSync(): MeetingSyncState {
  const [meeting, setMeeting] = useState<ActiveSyncMeeting | null>(null);
  const [status, setStatus] = useState<SyncMeetingStatus>('none');
  const [segments, setSegments] = useState<SyncTranscriptSegment[]>([]);
  const [interim, setInterim] = useState<{ speaker: string; text: string } | null>(null);
  const [coaching, setCoaching] = useState<SyncCoachingData | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const accountSyncWsRef = useRef<WebSocket | null>(null);
  const observeWsRef = useRef<WebSocket | null>(null);
  const accountSyncOpenRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meetingRef = useRef<ActiveSyncMeeting | null>(null);
  meetingRef.current = meeting;

  const dismiss = useCallback(() => setDismissed(true), []);

  const startObserving = useCallback((m: ActiveSyncMeeting) => {
    setMeeting(m);
    setStatus('active');
    setDismissed(false);
    setSegments([]);
    setInterim(null);
    setCoaching(null);

    observeWsRef.current?.close();
    const ws = new WebSocket(`${getWsBase()}/meetings/${m.id}/observe`);
    observeWsRef.current = ws;

    ws.onmessage = (evt) => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }
      if (msg.type === 'sync_snapshot') {
        setSegments(
          (msg.segments || []).map((s: any) => ({ speaker: s.speaker, text: s.text, isFinal: true, ts: s.ts }))
        );
        if (msg.coaching) setCoaching(msg.coaching);
      } else if (msg.type === 'interim') {
        setInterim({ speaker: msg.speaker || 'Speaker', text: msg.text || '' });
      } else if (msg.type === 'final') {
        setInterim(null);
        if (msg.text && String(msg.text).trim()) {
          setSegments((prev) => [...prev, { speaker: msg.speaker || 'Speaker', text: msg.text, isFinal: true }]);
        }
      } else if (msg.type === 'coaching' && msg.data) {
        setCoaching(msg.data);
      } else if (msg.type === 'meeting_ended') {
        setStatus('ended');
        ws.close();
      }
      // speaker_lock/unlock/merge intentionally not applied to synced
      // segments in this v1 pass — read-only display of speaker labels
      // as originally sent is sufficient for "see feedback on a different
      // screen"; full speaker-relabel parity is a nice-to-have follow-up,
      // not required by the feature request.
    };

    ws.onclose = () => {
      if (observeWsRef.current === ws) observeWsRef.current = null;
    };
  }, []);

  const handleMeetingEnded = useCallback(() => {
    setStatus('ended');
    observeWsRef.current?.close();
    observeWsRef.current = null;
  }, []);

  // Fallback REST poll — only runs while there's no known active synced
  // meeting AND the account-level WS isn't confirmed open (see file header
  // "ARCHITECTURE" note for why this is intentionally a backstop, not the
  // primary mechanism).
  const pollOnce = useCallback(async () => {
    if (meetingRef.current) return;
    try {
      const { active } = await getActiveSyncMeeting();
      if (active) startObserving(active);
    } catch {
      // Non-fatal — will retry next interval tick.
    }
  }, [startObserving]);

  useEffect(() => {
    let stopped = false;

    function connectAccountSync() {
      if (stopped) return;
      const ws = new WebSocket(`${getWsBase()}/api/sync`);
      accountSyncWsRef.current = ws;

      ws.onopen = () => {
        accountSyncOpenRef.current = true;
      };
      ws.onmessage = (evt) => {
        let msg: any;
        try {
          msg = JSON.parse(evt.data as string);
        } catch {
          return;
        }
        if (msg.type === 'meeting_started' && msg.meeting) {
          startObserving(msg.meeting);
        } else if (msg.type === 'meeting_ended') {
          if (meetingRef.current && meetingRef.current.id === msg.meetingId) {
            handleMeetingEnded();
          }
        }
      };
      ws.onclose = () => {
        accountSyncOpenRef.current = false;
        if (stopped) return;
        reconnectTimerRef.current = setTimeout(connectAccountSync, 5000);
      };
      ws.onerror = () => {
        // onclose fires right after; reconnect handled there.
      };
    }

    connectAccountSync();
    pollOnce();
    pollTimerRef.current = setInterval(() => {
      if (!accountSyncOpenRef.current) pollOnce();
    }, ACTIVE_SYNC_POLL_MS);

    return () => {
      stopped = true;
      accountSyncWsRef.current?.close();
      observeWsRef.current?.close();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, meeting, segments, interim, coaching, dismissed, dismiss };
}
