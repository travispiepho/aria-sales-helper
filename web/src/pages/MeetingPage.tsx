import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getMeeting,
  updateMeeting,
  renameMeeting,
  getMeetingSegments,
  getLatestCoaching,
  getCoachingReport,
  Meeting,
  CoachingReport,
  apiFetch,
} from '../lib/api';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';
import RebuttalTeleprompter, { SuggestedLibraryRebuttal } from '../components/RebuttalTeleprompter';
import { dismissLibraryRebuttal } from '../lib/api';
import MeetingScoreCard from '../components/MeetingScoreCard';
import CoachingReportCard from '../components/CoachingReportCard';
import { getWsBase } from '../lib/wsBase';
import { createReconnectTracker, ReconnectTracker } from '../lib/reconnectPolicy';
import AppHeader from '../components/AppHeader';
import BrowserCallControls from '../components/BrowserCallControls';
import MeetingTitleEditor from '../components/MeetingTitleEditor';
import { useBrowserCall } from '../lib/browserCall';
import { inRecordingPath, postRecordingPath } from '../lib/meetingRoutes';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptSegment {
  id?: string;
  speaker: string;
  text: string;
  isFinal: boolean;
  ts?: number;
  // 2026-08-18 (Deepgram reconnect hardening): 'text' (default, omitted) is
  // a normal transcript line. The other three render as inline system
  // notices in the transcript itself — NOT a silent gap — per Gabe's
  // explicit requirement that any lapse >2s be visible with its duration,
  // that recovery show a matching boundary marker, and that the 60s-budget
  // exhaustion show an unambiguous terminal notice (that truthfully states
  // the RECORDING is still being captured — only the live feed stopped).
  kind?: 'lapse-start' | 'lapse-end' | 'lapse-stopped';
  lapseDurationMs?: number;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatLapseDuration(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

// 2026-08-18 (Deepgram reconnect hardening) — renders a transcript-inline
// system notice for a connection lapse/recovery/terminal-stop, per Gabe's
// explicit requirement that this be VISIBLE IN THE TRANSCRIPT itself, not a
// silent gap or just a connection-status pill. Shared between the live and
// post-meeting transcript panels below so both stay in sync.
function TranscriptLapseNotice({ seg }: { seg: TranscriptSegment }) {
  if (seg.kind === 'lapse-start') {
    return (
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 my-1">
        ⚠️ Connection lost — live transcription paused. Recording continues.
      </div>
    );
  }
  if (seg.kind === 'lapse-end') {
    const dur = formatLapseDuration(seg.lapseDurationMs);
    return (
      <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 my-1">
        ✅ Reconnected{dur ? ` — live transcription was paused for ${dur}` : ''}.
      </div>
    );
  }
  if (seg.kind === 'lapse-stopped') {
    return (
      <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 my-1">
        🛑 Live transcription has stopped for this meeting. The recording is still being captured — the transcript can be backfilled afterward.
      </div>
    );
  }
  return null;
}

function formatDuration(startIso: string, endIso?: string): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  // ROOT-CAUSE FIX (2026-08-17 outbound-call diagnosis, Gabe's "Active ·
  // -1:-1" report): a phone-call meeting row's `started_at` is set to the
  // DB server's `now()` at INSERT time (server/telephony.js's
  // findOrCreatePhoneMeeting(), column default), which happens the instant
  // the rep taps "Call a Customer" — essentially simultaneous with this
  // page loading client-side. Any client/server clock skew (even a
  // fraction of a second — common across a container host vs a phone/
  // laptop clock) can put `end - start` slightly NEGATIVE for the first
  // render. formatElapsed() then computes Math.floor(negativeSeconds / 60)
  // and negativeSeconds % 60, both of which are negative in JS for a
  // negative dividend — e.g. -0.4s floors to -1 and -0.4 % 60 stays -0.4,
  // rendering exactly the literal string "-1:-1" Gabe saw. Clamping the
  // elapsed seconds to a minimum of 0 fixes this at the source for every
  // caller (header, post-meeting summary lines, etc.) without touching
  // `started_at`'s semantics — the row's actual creation timestamp remains
  // correct and meaningful; this only guards the display math.
  const elapsedSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return formatElapsed(elapsedSeconds);
}

// getWsBase() moved to lib/wsBase.ts (2026-08-05, live meeting sync
// full-page rebuild) so useMeetingSyncWatcher.ts can share the exact same
// derivation logic without a second copy — see that file's own header for
// why. Behavior is byte-for-byte identical to what lived here before.

// ─── Component ────────────────────────────────────────────────────────────────

export default function MeetingPage({ meetingId, pageMode }: { meetingId: string; pageMode: 'active' | 'post' }) {
  const navigate = useNavigate();
  const browserCall = useBrowserCall();

  // Meeting state
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  // 2026-08-17 (outbound-call diagnosis fix): a tick counter purely to
  // force a re-render once per second so the header's `Active ·
  // ${formatDuration(meeting.started_at)}` (a Twilio phone-call meeting
  // never sets isRecording locally, so it never had ANY periodic
  // re-render driving that string) actually counts up live instead of
  // being frozen at whatever value happened to render on load / the next
  // unrelated WS message. Not used for any value itself — formatDuration()
  // still computes off meeting.started_at and Date.now() at render time.
  const [, setHeaderTick] = useState(0);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');

  // 2026-08-17 (ARIA meeting UI by type, Part 1) — REAL server-side Twilio
  // recording state for phone-call meetings, NOT a client guess/optimistic
  // flag. Seeded from meeting.recording_status on load (covers a page
  // refresh/re-open mid-call), then kept live by the 'recording_state' WS
  // message (see applyLiveMessage below), which the server broadcasts the
  // instant /telephony/recording-status reports a change — see
  // server/telephony.js's recordingStatusCallback handler for the
  // broadcastToMeeting() call and its rationale for reusing this existing
  // per-meeting WS channel instead of a new poll/channel. 'in-progress' is
  // the only value that means "actually recording right now" per Twilio's
  // recordingStatusCallbackEvent semantics; 'completed'/'absent'/'failed'
  // all mean not-currently-recording for the purposes of this indicator.
  const [phoneRecordingStatus, setPhoneRecordingStatus] = useState<string | null>(null);

  // Consent state
  const [showConsentPrompt, setShowConsentPrompt] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);

  // End Meeting confirmation state — see handleEndMeetingButtonClick() below
  // for why this only gates the flow while actively recording.
  const [showEndMeetingConfirm, setShowEndMeetingConfirm] = useState(false);

  // Transcript state
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [interimSpeaker, setInterimSpeaker] = useState('');

  // Speaker labels (editable)
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});

  // Coaching state (Phase 3)
  const [coachingData, setCoachingData] = useState<CoachingData | null>(null);
  // Locked checked IDs — once an item is checked it NEVER unchecks, regardless of what Claude returns
  const [lockedChecked, setLockedChecked] = useState<Set<string>>(new Set());

  // Post-meeting
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryDownloadLoading, setSummaryDownloadLoading] = useState(false);
  const [voiceToast, setVoiceToast] = useState<string | null>(null);
  // ARIA Priority 1 roadmap, item 5: Live rebuttal teleprompter. Handles the
  // "suggested_rebuttal" WS message pushed by server.js's STUB objection
  // detector + REAL Claude-generated rebuttal (see objectionDetection.js /
  // coachingAnalysis.js's generateRebuttal() for the real-vs-stubbed
  // breakdown). This is a first-pass UI: a dismissible banner, not yet a
  // polished "teleprompter" UX — intentionally minimal per task scope.
  const [suggestedRebuttal, setSuggestedRebuttal] = useState<{ objectionCategory: string; rebuttal: string } | null>(null);
  // Live rebuttal teleprompter, in-meeting surfacing pass (2026-08-18,
  // 2nd pass) — library-backed prompts (`suggested_rebuttal_library` WS
  // pushes, matched against the Objections/Rebuttals library from commit
  // 053c81e). Keyed by objectionId so a repeat push for an objection
  // already on screen (e.g. duplicate broadcast on a reconnect) updates in
  // place instead of stacking a second card; the server-side concurrency
  // cap (objectionLibraryMatcher.js's MAX_CONCURRENT_PROMPTS) is the real
  // enforcement, this Map just mirrors it faithfully on the client.
  const [libraryRebuttalPrompts, setLibraryRebuttalPrompts] = useState<Map<string, SuggestedLibraryRebuttal>>(new Map());
  // Mid-call name-introduction confirmation (2026-08-10 intro-window fix).
  // Set from the `speaker_lock_suggestion` WS message; cleared once the user
  // answers (Yes/Edit/No) or another synced client answers first. Nothing is
  // locked until the user confirms via POST /api/meetings/:id/speaker-lock.
  const [speakerSuggestion, setSpeakerSuggestion] = useState<{ speakerId: string; name: string } | null>(null);
  const [speakerSuggestionBusy, setSpeakerSuggestionBusy] = useState(false);
  const [title, setTitle] = useState<string>('');
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  // Refs for audio pipeline
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioBufferRef = useRef<ArrayBuffer[]>([]);
  const reconnectAttemptsRef = useRef(0);
  const isRecordingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef<number>(0);

  // ── Live meeting sync full-page rebuild, 2026-08-05 ──────────────────────
  // Observer-mode socket (GET /meetings/:id/observe) — opened INSTEAD of the
  // owner's /meetings/:id/audio connection above when this session is not
  // the one that started the meeting (see isOwnerSession below). Kept as a
  // separate ref/connect function (not reusing wsRef/connectWebSocket)
  // because the two sockets are mutually exclusive per session for a given
  // meeting and have different lifecycles (audio: driven by isRecording;
  // observe: driven by meeting.status), but they feed the EXACT SAME
  // `applyLiveMessage()` handler below so live transcript/coaching/speaker
  // rendering is one code path regardless of which socket produced the
  // message — this is the actual code-reuse fix, not a second parallel UI.
  const observeWsRef = useRef<WebSocket | null>(null);
  const observeReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of meeting.status === 'active' / meeting.is_owner_session as
  // refs so socket close/reconnect closures (which capture at connect time,
  // not render time) always see the CURRENT value — same pattern already
  // used for isRecordingRef above.
  const isActiveRef = useRef(false);
  const isOwnerSessionRef = useRef(true);

  // ── Transcription lapse visibility (2026-08-18 hardening) ────────────────
  // Gabe's explicit requirement: any live-connection lapse >2s must be
  // visible IN THE TRANSCRIPT (not just a connection-status pill), with a
  // matching recovery marker showing the boundaries of what was missed, and
  // an unambiguous terminal notice once the server's reconnect budget (60s)
  // is exhausted. CRITICAL: do NOT rely solely on the server pushing a
  // notice — on 2026-08-17 the server broadcast correctly to a tab whose
  // socket had never actually connected, and the rep saw a silent stall.
  // The client tracks its OWN socket state below (see the reconnect timers'
  // own onclose logic) and can raise the same notice independently. Both
  // sources funnel through pushLapseNotice(), which dedupes so the rep sees
  // ONE notice per real lapse, not two, regardless of whether the server,
  // the client, or both detect it first.
  const dgLapseActiveRef = useRef(false); // true once a 'lapse-start' notice has been shown and not yet resolved
  const dgLapseTerminalRef = useRef(false); // true once the 60s-budget-exhaustion terminal notice has been shown for this connection
  const dgLapseStartedAtRef = useRef<number | null>(null); // client-observed lapse start time, for a client-computed duration on recovery
  // Client-side reconnect trackers (owner audio socket + observer socket),
  // one each, replacing the old no-jitter/no-budget reconnect loops below.
  // See web/src/lib/reconnectPolicy.ts header for why this is a client-side
  // twin rather than a shared import of the server's tracker.
  const wsReconnectTrackerRef = useRef<ReconnectTracker | null>(null);
  const observeReconnectTrackerRef = useRef<ReconnectTracker | null>(null);

  // ─── Load meeting ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId) return;
    Promise.all([
      getMeeting(meetingId),
      getMeetingSegments(meetingId),
      getLatestCoaching(meetingId),
    ])
      .then(([m, { segments: saved }, { coaching }]) => {
        if (pageMode === 'active' && m.status !== 'active') {
          navigate(postRecordingPath(m.id), { replace: true });
          return;
        }
        if (pageMode === 'post' && m.status === 'active') {
          navigate(inRecordingPath(m.id), { replace: true });
          return;
        }
        setMeeting(m);
        setTitle(m.title || m.customer_name || '');
        // 2026-08-17: seed the recording indicator from the DB snapshot so a
        // page refresh mid-call shows correct state immediately, not just
        // after the next WS push (which may be seconds/minutes away if
        // Twilio's recordingStatusCallback already fired before this load).
        setPhoneRecordingStatus(m.recording_status ?? null);
        // Restore persisted speaker labels
        if (m.speaker_labels && Object.keys(m.speaker_labels).length > 0) {
          setSpeakerLabels(m.speaker_labels);
        }
        if (coaching) {
          const c = coaching as CoachingData;
          setCoachingData(c);
          // Seed locked set from DB snapshot so page-reload state is sticky too
          if (c.checklist) {
            setLockedChecked(new Set(c.checklist.filter(i => i.done).map(i => i.id)));
          }
        }
        if (saved.length > 0) {
          setSegments(saved.map(s => ({
            id: s.id,
            speaker: s.speaker,
            text: s.text,
            isFinal: true,
            ts: new Date(s.ts).getTime(),
          })));
        }
      })
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [meetingId, navigate, pageMode]);

  // ─── Smart auto-scroll: only scroll if user hasn't scrolled up ─────────────

  function handleTranscriptScroll() {
    const el = transcriptContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 80;
  }

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = transcriptContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments, interimText]);

  // ─── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopRecording(); // no-op if this session never started a mic (observer view)
      // 2026-08-05: also tear down the observer socket/reconnect timer on
      // unmount — the owner-vs-observer effect above only closes it on a
      // status/ownership CHANGE, not on navigating away from the page
      // entirely (e.g. the rep taps ← Back while still observing).
      if (observeReconnectTimerRef.current) clearTimeout(observeReconnectTimerRef.current);
      observeWsRef.current?.close();
      observeWsRef.current = null;
      wsReconnectTrackerRef.current?.dispose();
      observeReconnectTrackerRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Wake Lock ────────────────────────────────────────────────────────────

  async function acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current?.addEventListener('release', () => {
          // Re-acquire if still recording (e.g., tab became visible again)
          if (isRecordingRef.current) {
            acquireWakeLock();
          }
        });
      } catch {
        // Non-fatal: device may not support it
      }
    }
  }

  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  // ─── Lapse notice de-dup (server-detected AND client-detected raise the same UI) ──
  // Either detection path calls this; whichever fires first wins and the
  // other becomes a no-op for that same lapse, so the rep sees exactly one
  // start notice and exactly one matching recovery/terminal notice.
  const pushLapseStartNotice = useCallback((startedAtMs?: number) => {
    if (dgLapseActiveRef.current || dgLapseTerminalRef.current) return; // already showing/shown for this lapse
    dgLapseActiveRef.current = true;
    dgLapseStartedAtRef.current = startedAtMs ?? Date.now();
    setSegments(prev => [...prev, { speaker: '', text: '', isFinal: true, ts: Date.now(), kind: 'lapse-start' }]);
  }, []);

  const pushLapseEndNotice = useCallback((durationMs?: number) => {
    if (!dgLapseActiveRef.current) return; // no active lapse notice to resolve (e.g. blip never crossed 2s)
    dgLapseActiveRef.current = false;
    const observedDuration = durationMs ?? (dgLapseStartedAtRef.current ? Date.now() - dgLapseStartedAtRef.current : undefined);
    dgLapseStartedAtRef.current = null;
    setSegments(prev => [...prev, { speaker: '', text: '', isFinal: true, ts: Date.now(), kind: 'lapse-end', lapseDurationMs: observedDuration }]);
  }, []);

  const pushLapseStoppedNotice = useCallback(() => {
    if (dgLapseTerminalRef.current) return; // already shown the terminal notice for this connection
    dgLapseTerminalRef.current = true;
    dgLapseActiveRef.current = false;
    dgLapseStartedAtRef.current = null;
    setSegments(prev => [...prev, { speaker: '', text: '', isFinal: true, ts: Date.now(), kind: 'lapse-stopped' }]);
  }, []);

  // ─── Shared live-message handler (owner audio socket AND observer socket) ──
  // 2026-08-05 (live meeting sync full-page rebuild): extracted from the
  // owner /meetings/:id/audio connection's onmessage handler so the
  // /meetings/:id/observe connection (opened for a non-owner session below,
  // see connectObserverSocket()) can feed the EXACT SAME state updates —
  // the same live transcript/coaching/speaker-relabel rendering, no second
  // parallel implementation to keep in sync by hand. This is the actual
  // "reuse the existing MeetingPage rendering for both scenarios"
  // requirement: one message handler, two socket sources.
  const applyLiveMessage = useCallback((msg: any) => {
    if (msg.type === 'interim') {
      setInterimText(msg.text || '');
      setInterimSpeaker(msg.speaker || '');
    } else if (msg.type === 'final') {
      setInterimText('');
      setInterimSpeaker('');
      if (msg.text && msg.text.trim()) {
        setSegments(prev => [
          ...prev,
          {
            // 2026-08-09: server now attaches the just-inserted DB row's
            // UUID to the 'final' broadcast (see server.js). If the insert
            // failed server-side, msg.id is undefined and this segment is
            // the genuine remaining edge case that falls back to the
            // composite key below (id-less live segment, no DB row).
            id: msg.id,
            speaker: msg.speaker || 'Speaker',
            text: msg.text,
            isFinal: true,
            ts: Date.now(),
          },
        ]);
      }
    } else if (msg.type === 'speaker_repair') {
      const corrections = Array.isArray(msg.corrections) ? msg.corrections : [];
      const byId = new Map<string, string>(corrections
        .filter((item: any) => typeof item?.id === 'string' && typeof item?.speaker === 'string')
        .map((item: any): [string, string] => [String(item.id), String(item.speaker)]));
      if (byId.size > 0) {
        setSegments(prev => prev.map(segment => {
          const repaired = segment.id ? byId.get(segment.id) : undefined;
          return repaired ? { ...segment, speaker: repaired } : segment;
        }));
      }
      if (msg.speakerLabels && typeof msg.speakerLabels === 'object') {
        setSpeakerLabels(msg.speakerLabels as Record<string, string>);
      }
    } else if (msg.type === 'speaker_lock') {
      const { speakerId, name, source } = msg as { type: string; speakerId: string; name: string; source?: string };
      if (source === 'introduction') {
        // Introduction labels are already persisted atomically with the
        // transcript relabel on the server. Update local rendering only;
        // sending the page's stale full speaker_labels map back here could
        // overwrite the second identity when rep/customer events arrive close
        // together.
        setSpeakerLabels(prev => ({ ...prev, [speakerId]: name }));
      } else {
        // Voice/manual confirmation still uses the existing persistence path.
        handleSpeakerLabelChange(speakerId, name);
      }
      setVoiceToast(source === 'introduction' ? `✓ ${name} identified from the introduction` : `🎙️ ${name} identified`);
      setTimeout(() => setVoiceToast(null), 4000);
    } else if (msg.type === 'speaker_unlock') {
      // Server detected the rep-voiceprint lock drifted (likely a wrong
      // initial match) and released it. No relabeling here — leave
      // already-rendered segments as-is; a fresh speaker_lock will
      // arrive once re-verification finds the right speaker again.
      setVoiceToast(`⚠️ Re-checking speaker match…`);
      setTimeout(() => setVoiceToast(null), 3000);
    } else if (msg.type === 'speaker_merge') {
      // Server detected Deepgram over-segmented one person into two
      // speaker indices and merged them. Rewrite already-rendered
      // segments in place and carry forward any manual label the user
      // had set on the stale speaker id.
      const { from, to } = msg as { type: string; from: string; to: string };
      setSegments(prev => prev.map(seg => (seg.speaker === from ? { ...seg, speaker: to } : seg)));
      setSpeakerLabels(prev => {
        if (prev[from] === undefined) return prev;
        const next = { ...prev };
        if (next[to] === undefined) next[to] = next[from];
        delete next[from];
        return next;
      });
    } else if (msg.type === 'speaker_lock_suggestion') {
      // Mid-call name-introduction GUESS (not a committed lock). Show a
      // confirmation popup; the user's Yes/Edit/No answer drives
      // POST /api/meetings/:id/speaker-lock (see confirmSpeakerSuggestion /
      // rejectSpeakerSuggestion below). We do NOT relabel anything yet.
      const { speakerId, name } = msg as { type: string; speakerId: string; name: string };
      if (speakerId && name) setSpeakerSuggestion({ speakerId, name });
    } else if (msg.type === 'speaker_lock_suggestion_dismiss') {
      // Another synced client answered (or the server withdrew the guess) —
      // close our popup if it was for the same speaker.
      const { speakerId } = msg as { type: string; speakerId: string };
      setSpeakerSuggestion(prev => (prev && prev.speakerId === speakerId ? null : prev));
    } else if (msg.type === 'suggested_rebuttal') {
      // Live rebuttal teleprompter (item 5) — first-pass scaffolding.
      const { objectionCategory, rebuttal } = msg as { type: string; objectionCategory: string; rebuttal: string };
      setSuggestedRebuttal({ objectionCategory, rebuttal });
    } else if (msg.type === 'suggested_rebuttal_library') {
      // Live rebuttal teleprompter, in-meeting surfacing pass (2026-08-18
      // 2nd pass) — library-backed match (server/objectionLibraryMatcher.js),
      // separate from the STUB `suggested_rebuttal` handled just above.
      const payload = msg as unknown as SuggestedLibraryRebuttal & { type: string };
      setLibraryRebuttalPrompts((prev) => {
        const next = new Map(prev);
        next.set(payload.objectionId, {
          objectionId: payload.objectionId,
          objectionText: payload.objectionText,
          objectionCategory: payload.objectionCategory,
          rebuttals: payload.rebuttals,
          matchedSegmentText: payload.matchedSegmentText,
          confidence: payload.confidence,
          matchMethod: payload.matchMethod,
        });
        return next;
      });
    } else if (msg.type === 'suggested_rebuttal_library_dismiss') {
      // Another synced client (e.g. an observer) dismissed this prompt —
      // close it here too so both views agree, same pattern as
      // `speaker_lock_suggestion_dismiss` above.
      const { objectionId } = msg as { type: string; objectionId: string };
      setLibraryRebuttalPrompts((prev) => {
        if (!prev.has(objectionId)) return prev;
        const next = new Map(prev);
        next.delete(objectionId);
        return next;
      });
    } else if (msg.type === 'coaching' && msg.data) {
      // Phase 3: real-time coaching update
      const incoming = msg.data as CoachingData;
      // Grow the locked set — never shrink it
      if (incoming.checklist) {
        setLockedChecked(prev => {
          const next = new Set(prev);
          incoming.checklist.filter(i => i.done).forEach(i => next.add(i.id));
          return next;
        });
      }
      // Store raw coaching data (lockedChecked handles sticky state at render time)
      setCoachingData(incoming);
    } else if (msg.type === 'transcription_lapse') {
      // Server-detected lapse/recovery/terminal notice (server/server.js's
      // in-person handler or server/telephony.js's phone handler, both via
      // the shared dgReconnectPolicy tracker). This is one of TWO detection
      // paths that can raise this notice — see pushLapseStartNotice's own
      // comment for why client-side detection also exists and how the two
      // are deduped to a single visible notice.
      const { state, durationMs } = msg as { type: string; state: 'started' | 'recovered' | 'stopped'; durationMs?: number };
      if (state === 'started') pushLapseStartNotice();
      else if (state === 'recovered') pushLapseEndNotice(durationMs);
      else if (state === 'stopped') pushLapseStoppedNotice();
    } else if (msg.type === 'recording_state') {
      // 2026-08-17 (ARIA meeting UI by type, Part 1) — pushed by server/
      // telephony.js's /telephony/recording-status handler the instant
      // Twilio reports a recording-lifecycle change (in-progress on
      // customer-answer, completed/absent/failed on hangup). This is the
      // ONLY thing that flips the phone-call recording indicator on/off —
      // no client timer, no optimistic flip on "we placed the call".
      const { status } = msg as { type: string; status: string | null };
      setPhoneRecordingStatus(status ?? null);
    } else if (msg.type === 'meeting_ended') {
      // Observer-only in practice (the owner learns the meeting ended via its
      // own updateMeeting() response, not this message) — the mobile device
      // finalized the meeting (End Meeting tap, or server-side
      // finalizeMeetingIfAbandoned() on a dropped connection). Re-fetch so
      // this page flips from the live "Active meeting" branch to the
      // post-meeting branch with the final status/ended_at from the server,
      // same as if the owner's own handleEndMeeting() had run locally.
      if (meetingId) {
        getMeeting(meetingId).then(latest => {
          if (latest.status !== 'active') {
            navigate(postRecordingPath(latest.id), { replace: true });
          }
        }).catch(() => {});
      }
    }
  }, [meetingId, navigate, pushLapseStartNotice, pushLapseEndNotice, pushLapseStoppedNotice]);

  // ─── WebSocket connection (owner: audio streaming) ───────────────────────

  const connectWebSocket = useCallback(() => {
    if (!meetingId) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionStatus('connecting');

    const wsUrl = `${getWsBase()}/meetings/${meetingId}/audio`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    if (!wsReconnectTrackerRef.current) {
      // Lazily created once, reused across reconnects on this ref (mirrors
      // reconnectAttemptsRef's own lifetime before this pass) so lapse
      // state ("how long has THIS outage been going") persists correctly
      // across repeated connectWebSocket() calls from onclose below.
      wsReconnectTrackerRef.current = createReconnectTracker({
        // CLIENT-SIDE lapse detection — this is the second of the two
        // required detection paths (see pushLapseStartNotice's own comment):
        // the client knows its OWN socket state and can raise this notice
        // even if the server never gets a chance to broadcast one (e.g. the
        // server process itself is what's unreachable). Deduped against the
        // server-detected path via dgLapseActiveRef/dgLapseTerminalRef so
        // the rep sees one notice regardless of which side notices first.
        onLapseStart: (startedAtMs) => pushLapseStartNotice(startedAtMs),
        onLapseEnd: (durationMs) => pushLapseEndNotice(durationMs),
        onGiveUp: () => pushLapseStoppedNotice(),
      });
    }
    const tracker = wsReconnectTrackerRef.current;

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;
      tracker.onConnected();

      // Flush buffered audio
      const buffered = audioBufferRef.current.splice(0);
      buffered.forEach(chunk => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    };

    ws.onmessage = (evt) => {
      try {
        applyLiveMessage(JSON.parse(evt.data as string));
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      setConnectionStatus('reconnecting');
    };

    ws.onclose = () => {
      if (!isRecordingRef.current) {
        setConnectionStatus('disconnected');
        return;
      }
      // 2026-08-18 hardening: jittered backoff (250ms→8s) with a real ~60s
      // time budget as the primary give-up control (was: no-jitter 1s→10s
      // with no budget/ceiling at all — would retry forever). See
      // web/src/lib/reconnectPolicy.ts for the full rationale.
      setConnectionStatus('reconnecting');
      const result = tracker.onDisconnect();
      if ('giveUp' in result) {
        setConnectionStatus('disconnected');
        return; // tracker already invoked onGiveUp (pushLapseStoppedNotice) above
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (isRecordingRef.current) {
          connectWebSocket();
        }
      }, result.delayMs);
    };
  }, [meetingId, pushLapseStartNotice, pushLapseEndNotice, pushLapseStoppedNotice]);

  // ─── WebSocket connection (observer: read-only mobile-meeting sync) ───────
  // 2026-08-05 (live meeting sync full-page rebuild). Opened INSTEAD of the
  // owner audio socket above when this session did not start the meeting
  // (see the useEffect below that chooses between the two). NEVER captures
  // a mic, NEVER opens an AudioContext/AudioWorklet, NEVER sends anything
  // on this socket — purely receive-only, same server-side contract
  // /meetings/:id/observe has always had (see server.js's route comment).
  // Every message it receives is handed to the SAME applyLiveMessage()
  // the owner's audio socket uses — that shared function is what makes
  // this "reuse the existing MeetingPage rendering" rather than a second
  // parallel transcript-rendering implementation.
  const connectObserverSocket = useCallback(() => {
    if (!meetingId) return;
    if (observeWsRef.current && observeWsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionStatus('connecting');

    const ws = new WebSocket(`${getWsBase()}/meetings/${meetingId}/observe`);
    observeWsRef.current = ws;

    if (!observeReconnectTrackerRef.current) {
      observeReconnectTrackerRef.current = createReconnectTracker({
        onLapseStart: (startedAtMs) => pushLapseStartNotice(startedAtMs),
        onLapseEnd: (durationMs) => pushLapseEndNotice(durationMs),
        onGiveUp: () => pushLapseStoppedNotice(),
      });
    }
    const observeTracker = observeReconnectTrackerRef.current;

    ws.onopen = () => {
      setConnectionStatus('connected');
      observeTracker.onConnected();
    };

    ws.onmessage = (evt) => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }
      if (msg.type === 'sync_snapshot') {
        // Initial catch-up snapshot, sent once right after connect — mirrors
        // what getMeeting()/getMeetingSegments()/getLatestCoaching() already
        // gave THIS page on load for an owner session, just pushed
        // proactively instead of requiring a second REST round-trip. Only
        // apply if we don't already have segments (e.g. from the initial
        // load effect above resolving first) to avoid a duplicate-render
        // flash — harmless either way since both sources agree, but avoids
        // a visible re-sort/re-render blip.
        setSegments(prev => (prev.length > 0 ? prev : (msg.segments || []).map((s: any) => ({
          id: s.id,
          speaker: s.speaker,
          text: s.text,
          isFinal: true,
          ts: new Date(s.ts).getTime(),
        }))));
        if (msg.coaching) {
          const c = msg.coaching as CoachingData;
          setCoachingData(c);
          if (c.checklist) {
            setLockedChecked(prev => {
              const next = new Set(prev);
              c.checklist.filter(i => i.done).forEach(i => next.add(i.id));
              return next;
            });
          }
        }
      } else {
        applyLiveMessage(msg);
      }
    };

    ws.onerror = () => {
      setConnectionStatus('reconnecting');
    };

    ws.onclose = () => {
      if (observeWsRef.current === ws) observeWsRef.current = null;
      setConnectionStatus('disconnected');
      // Reconnect while the meeting is still active on the phone — mirrors
      // the owner audio socket's own reconnect-while-recording behavior
      // above. isActiveRef (declared further below, tracks meeting.status)
      // lets this closure see current status without re-subscribing.
      // 2026-08-18 hardening: jittered backoff + ~60s budget (was: a flat
      // 3000ms retry forever) — same reasoning as the owner socket above.
      if (isActiveRef.current && !isOwnerSessionRef.current) {
        const result = observeTracker.onDisconnect();
        if ('giveUp' in result) return; // tracker already invoked onGiveUp (pushLapseStoppedNotice) above
        observeReconnectTimerRef.current = setTimeout(connectObserverSocket, result.delayMs);
      }
    };
  }, [meetingId, applyLiveMessage, pushLapseStartNotice, pushLapseEndNotice, pushLapseStoppedNotice]);

  // ─── Owner vs. observer: which live socket (if any) should be open ──────
  // 2026-08-05 (live meeting sync full-page rebuild) — THE core routing
  // decision that replaces the old popup's separate code path. This page
  // is reused verbatim for both scenarios; the only thing that changes is
  // which live socket (if any) feeds applyLiveMessage():
  //   - Active meeting, owner session (normal web-started meeting, or the
  //     mobile owner viewing their OWN meeting on web — rare but not
  //     disallowed): no socket opened by THIS effect at all — the owner's
  //     mic/audio socket is opened explicitly by handleStartButton() /
  //     connectWebSocket(), driven by the Record button, exactly as
  //     before this rework. This effect does nothing in that case.
  //   - Active meeting, NON-owner session (a web tab observing a
  //     mobile-started meeting): open the read-only observer socket
  //     automatically — there is no Record button to wait for; the
  //     transcript is already being produced by the phone's mic.
  //   - Not active (completed/cancelled/interrupted): close whichever
  //     socket might still be open and don't reconnect — same terminal
  //     handling for both owner and observer.
  useEffect(() => {
    if (!meeting) return;
    const active = meeting.status === 'active';
    // Permissive default (true) when is_owner_session is omitted — matches
    // the server's own permissive-when-NULL convention (shapeMeetingForClient()
    // in server.js), so a pre-migration meeting record is never mistakenly
    // treated as an observer view with no owner controls.
    const owner = meeting.is_owner_session !== false;
    isActiveRef.current = active;
    isOwnerSessionRef.current = owner;

    // 2026-08-17 ROOT-CAUSE FIX (outbound-call diagnosis task): a Twilio
    // phone-call meeting (channel === 'phone' && !!call_sid) is ALWAYS
    // "owner session" from the server's point of view (the rep who placed
    // the call authenticated this request), so the `active && !owner`
    // condition below NEVER opened any live socket for it — and
    // connectWebSocket() (the OTHER live socket) is also never invoked for
    // a Twilio phone call, because startRecording()/handleStartButton() is
    // the ONLY caller of connectWebSocket() and the phone-call UI branch
    // (isTwilioPhoneCall below) replaces the Record button with a
    // non-interactive status indicator with no onClick at all — there is
    // no client-captured mic for a Twilio call, so that's correct. Net
    // effect: the owner's browser for a Twilio phone-call meeting NEVER
    // opened ANY WebSocket to the server. broadcastToMeeting() calls for
    // recording_state (telephony.js's /telephony/recording-status handler)
    // and every live transcript segment (server.js's Deepgram-final path)
    // had zero registered sockets to reach on this device — they were not
    // failing, they were being broadcast into a void. This is the single
    // root cause behind ALL THREE of Gabe's reported symptoms: recording
    // indicator stuck on "Waiting to record…", and the live-transcript
    // panel stuck on the empty-state message, despite the server-side
    // Twilio Media Stream + Deepgram pipeline actually working correctly
    // (confirmed via production DB rows: transcript_segments rows DID
    // exist for both of Gabe's test calls, and recording_status DID reach
    // 'in-progress'/'completed' in the meetings table — the data was
    // produced, just never delivered to this open tab).
    //
    // Fix: also open the same read-only "observer" socket used for
    // mobile-sync viewing whenever this is an active Twilio phone-call
    // meeting, even though `owner` is true. GET /meetings/:meetingId/observe
    // on the server only checks `meeting.rep_id === user.id` (or admin) —
    // it has no owner-vs-observer distinction of its own, so the rep who
    // placed this exact call passes that check trivially. This socket is
    // receive-only (never sends audio), which is exactly right here: audio
    // capture for a Twilio call happens over server-to-Twilio's own Media
    // Stream (/telephony/stream), not this browser's mic, so there is
    // nothing for this device to transmit — it only needs to RECEIVE the
    // recording_state / transcript / coaching pushes, which is the
    // observer socket's entire contract.
    const isTwilioPhoneMeeting = meeting.channel === 'phone' && !!meeting.call_sid;

    if (active && (!owner || isTwilioPhoneMeeting)) {
      connectObserverSocket();
    } else {
      if (observeReconnectTimerRef.current) {
        clearTimeout(observeReconnectTimerRef.current);
        observeReconnectTimerRef.current = null;
      }
      observeWsRef.current?.close();
      observeWsRef.current = null;
    }
  }, [meeting, connectObserverSocket]);

  // 2026-08-17 (outbound-call diagnosis fix) — header timer tick for a
  // Twilio phone-call meeting. The in-person/observer paths already get a
  // periodic re-render for free (isRecording's elapsedSec interval, or the
  // steady stream of WS transcript/coaching pushes an observer socket
  // receives), which is WHY this bug was invisible there — but a phone-
  // call meeting's owner tab can sit for a while between recording_state /
  // transcript pushes with nothing else forcing React to re-run
  // formatDuration(meeting.started_at) against the current Date.now(), so
  // the header's elapsed time silently freezes between pushes. A plain
  // 1s interval, scoped to only run while this is an active Twilio phone
  // call, fixes that with no interaction with the unrelated in-person
  // elapsedSec/isRecording timer above.
  useEffect(() => {
    if (!meeting) return;
    const active = meeting.status === 'active';
    const isTwilioPhoneMeeting = meeting.channel === 'phone' && !!meeting.call_sid;
    if (!active || !isTwilioPhoneMeeting) return;
    const id = setInterval(() => setHeaderTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [meeting]);

  // ─── Start recording ──────────────────────────────────────────────────────

  async function startRecording() {
    if (!meetingId) return;

    // Step 1: Get mic
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      alert('Microphone access denied. Please allow microphone access and try again.');
      return;
    }
    mediaStreamRef.current = stream;

    // Step 2: AudioContext + AudioWorklet
    const ctx = new AudioContext({ sampleRate: 48000 });
    audioContextRef.current = ctx;

    try {
      await ctx.audioWorklet.addModule('/audio-processor.js');
    } catch (err) {
      console.error('AudioWorklet load failed:', err);
      alert('Audio processor failed to load. Please reload the page.');
      ctx.close();
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, 'pcm-processor');
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (evt) => {
      const buffer = evt.data as ArrayBuffer;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(buffer);
      } else {
        // Buffer up to ~30s at 16kHz/16-bit = 32 bytes/ms → 960,000 bytes
        const totalBuffered = audioBufferRef.current.reduce((s, b) => s + b.byteLength, 0);
        if (totalBuffered < 960_000) {
          audioBufferRef.current.push(buffer);
        }
      }
    };

    source.connect(workletNode);
    workletNode.connect(ctx.destination); // required to keep worklet running in Safari

    // Step 3: Connect WebSocket
    isRecordingRef.current = true;
    setIsRecording(true);
    connectWebSocket();

    // Step 4: Elapsed timer
    recordingStartRef.current = Date.now();
    elapsedIntervalRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - recordingStartRef.current) / 1000));
    }, 1000);

    // Step 5: Wake Lock
    await acquireWakeLock();
  }

  // ─── Stop recording ───────────────────────────────────────────────────────

  function stopRecording() {
    isRecordingRef.current = false;
    userScrolledUpRef.current = false; // re-enable auto-scroll after recording

    // Clear reconnect timer
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close WebSocket
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionStatus('disconnected');
    // Intentional stop (rep tapped End/stop), not a failure — dispose the
    // reconnect tracker quietly so no stray give-up/lapse notice fires
    // after the rep deliberately ended the session.
    wsReconnectTrackerRef.current?.dispose();

    // Stop AudioWorklet
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    // Close AudioContext
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    // Stop mic tracks
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;

    // Clear elapsed timer
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }

    // Release wake lock
    releaseWakeLock();

    setIsRecording(false);
    audioBufferRef.current = [];
  }

  // ─── Consent + start flow ─────────────────────────────────────────────────

  function handleStartButton() {
    if (!consentConfirmed) {
      setShowConsentPrompt(true);
    } else {
      startRecording();
    }
  }

  async function handleConsentConfirm() {
    setShowConsentPrompt(false);
    setConsentConfirmed(true);

    // Log consent to server
    if (meetingId) {
      try {
        await apiFetch(`/api/meetings/${meetingId}/consent`, { method: 'POST' });
      } catch {
        // Non-fatal
      }
    }

    await startRecording();
  }

  // ─── End meeting ───────────────────────────────────────────────────────────────

  // 2026-08-05: single consolidated handler for the ONE "End Meeting" action.
  // Previously the big Record circle also acted as a separate "stop
  // recording" control while active, calling stopRecording() on its own with
  // no meeting finalization — a rep could stop the mic and leave the meeting
  // stuck 'active' forever. That control is now a status indicator only (see
  // render section below). This is the single remaining flow, in order:
  //   1. stopRecording() — tears down the whole client-side audio pipeline:
  //      closes the WebSocket, disconnects/stops the AudioWorklet node,
  //      closes the AudioContext, stops all mic MediaStream tracks, clears
  //      the elapsed-time interval, releases the wake lock, resets
  //      isRecording/connectionStatus state.
  //   2. PATCH /api/meetings/:id via updateMeeting() — marks the meeting
  //      status: 'completed' with ended_at set to now.
  //   3. setMeeting(updated) — swaps the local meeting object to the
  //      server's response, which flips isActive to false and switches the
  //      page from the live "Active meeting" view to the "Post-meeting" view
  //      (transcript, summary/export actions, etc.) via the existing
  //      isActive-gated render branches — no separate navigation call needed.
  // Note: this does NOT trigger summary generation — that remains a
  // separate, explicit "✨ Generate Summary" action in the post-meeting view
  // (pre-existing behavior, unchanged by this pass).
  async function handleEndMeeting() {
    stopRecording();
    if (!meetingId) return;
    try {
      const updated = await updateMeeting(meetingId, {
        status: 'completed',
        ended_at: new Date().toISOString(),
      });
      if (updated.status === 'active') throw new Error('The meeting is still active. Please try again.');
      navigate(postRecordingPath(updated.id), { replace: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to end meeting');
    }
  }

  // 2026-08-05: entry point for the bottom "End Meeting" button. Now that
  // this button is the ONLY way to stop a recording (see handleEndMeeting()
  // above and the removed separate stop-recording control), ending a meeting
  // while actively recording is a more consequential, harder-to-undo action
  // than it used to be — a stray tap mid-sentence kills the mic and
  // finalizes the meeting in one shot. So: gate on isRecording and show a
  // confirm dialog first.
  //
  // If isActive but NOT isRecording (rep started a meeting, tapped Record,
  // then already tapped End Meeting once and is looking at... actually this
  // state doesn't really occur in the UI today — the only way to reach
  // "active" without "recording" is before the rep has hit Record at all,
  // i.e. no audio has been captured yet). In that case there's nothing to
  // lose — no live recording to interrupt, and ending just marks an
  // essentially-empty meeting as completed. Skipping the confirm there
  // matches "probably not" from the task brief: the only consequential,
  // hard-to-undo path is stopping an in-progress recording, so that's the
  // only path that gets the extra click.
  function handleEndMeetingButtonClick() {
    if (isRecording) {
      setShowEndMeetingConfirm(true);
    } else {
      handleEndMeeting();
    }
  }

  // ─── Save title ───────────────────────────────────────────────────────────

  async function handleSaveTitle() {
    const trimmedTitle = title.trim();
    if (!meetingId) {
      setTitleError('This meeting is still being created. Try again in a moment.');
      return;
    }
    if (!trimmedTitle) {
      setTitleError('Title cannot be empty.');
      return;
    }
    if (titleSaving || trimmedTitle === (meeting?.title || '').trim()) return;
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await renameMeeting(meetingId, trimmedTitle);
      if (updated.title !== trimmedTitle) {
        throw new Error('The saved title did not match. Please try again.');
      }
      setTitle(updated.title || trimmedTitle);
      setMeeting(prev => prev ? { ...prev, title: updated.title } : prev);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : 'Failed to save meeting title.');
    } finally {
      setTitleSaving(false);
    }
  }

  // ─── Generate summary ─────────────────────────────────────────────────────

  function handleDownloadTranscript() {
    if (!meeting) return;
    const meetingDate = new Date(meeting.started_at).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const meetingTime = new Date(meeting.started_at).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
    });
    const displayTitle = title || meeting.customer_name || 'Meeting';
    const activeSummary = summary || meeting.summary;

    const lines: string[] = [];
    lines.push(`ARIA MEETING TRANSCRIPT`);
    lines.push(`${'='.repeat(60)}`);
    lines.push(`Title:    ${displayTitle}`);
    lines.push(`Customer: ${meeting.customer_name}`);
    lines.push(`Date:     ${meetingDate} at ${meetingTime}`);
    if (meeting.ended_at) {
      lines.push(`Duration: ${formatDuration(meeting.started_at, meeting.ended_at)}`);
    }
    lines.push('');

    if (activeSummary) {
      lines.push(`SUMMARY`);
      lines.push(`${'─'.repeat(60)}`);
      lines.push(activeSummary);
      lines.push('');
    }

    lines.push(`TRANSCRIPT`);
    lines.push(`${'─'.repeat(60)}`);
    if (segments.length === 0) {
      lines.push('(no transcript recorded)');
    } else {
      let lastSpeaker = '';
      segments.forEach(seg => {
        const label = getDisplayLabel(seg.speaker);
        if (label !== lastSpeaker) {
          if (lastSpeaker) lines.push('');
          lines.push(`[${label}]`);
          lastSpeaker = label;
        }
        lines.push(seg.text);
      });
    }
    lines.push('');
    lines.push(`${'='.repeat(60)}`);
    lines.push(`Generated by ARIA — CertaPro Grand Haven`);

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${displayTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadSummary() {
    if (!meeting) return;
    setSummaryDownloadLoading(true);

    // The report card owns its own state, so fetch the same already-existing
    // aggregate endpoint at download time. If no coaching report has been
    // generated (or it is temporarily unavailable), the meeting summary is
    // still useful and should download on its own.
    let report: CoachingReport | null = null;
    if (meetingId) {
      try {
        report = await getCoachingReport(meetingId);
      } catch {
        report = null;
      }
    }

    try {
      const activeSummary = summary || meeting.summary || '';
      const displayTitle = title || meeting.customer_name || 'Meeting';
      const meetingDate = new Date(meeting.started_at).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      const meetingTime = new Date(meeting.started_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
      });
      const lines: string[] = [];

      lines.push('ARIA FEEDBACK & SUMMARY');
      lines.push('='.repeat(60));
      lines.push(`Title:    ${displayTitle}`);
      lines.push(`Customer: ${meeting.customer_name}`);
      lines.push(`Date:     ${meetingDate} at ${meetingTime}`);
      if (meeting.ended_at) {
        lines.push(`Duration: ${formatDuration(meeting.started_at, meeting.ended_at)}`);
      }
      lines.push('');
      lines.push('AI-GENERATED SUMMARY');
      lines.push('─'.repeat(60));
      lines.push(activeSummary.replace(/\*/g, '') || '(no summary generated)');

      if (report) {
        const hasMetrics = report.meetingScore !== null
          || report.coveragePct !== null
          || report.wpm.avg !== null
          || report.discAdaptationScore !== null;
        const hasCoachingFeedback = report.bant
          || report.insiderLanguageFlags.length > 0
          || report.questionGaps.length > 0
          || hasMetrics;

        if (hasCoachingFeedback) {
          lines.push('');
          lines.push('COACHING FEEDBACK');
          lines.push('─'.repeat(60));

          if (hasMetrics) {
            lines.push('Performance Metrics');
            if (report.meetingScore !== null) lines.push(`- Meeting Score: ${report.meetingScore}/100`);
            if (report.coveragePct !== null) lines.push(`- Checklist Coverage: ${report.coveragePct}%`);
            if (report.wpm.avg !== null) lines.push(`- Speaking Pace: ${report.wpm.avg} WPM`);
            if (report.discAdaptationScore !== null) lines.push(`- DISC Adaptation: ${report.discAdaptationScore}/100`);
          }

          if (report.bant) {
            if (hasMetrics) lines.push('');
            lines.push('BANT & Closing Certainty');
            lines.push(`- Closing Certainty: ${report.bant.closing_certainty_pct}%`);
            if (report.bant.rationale?.overall) lines.push(`  ${report.bant.rationale.overall}`);
            const factors: [string, number, string | undefined][] = [
              ['Budget', report.bant.budget_score, report.bant.rationale?.budget],
              ['Authority', report.bant.authority_score, report.bant.rationale?.authority],
              ['Need', report.bant.need_score, report.bant.rationale?.need],
              ['Timeline', report.bant.timeline_score, report.bant.rationale?.timeline],
            ];
            factors.forEach(([label, score, rationale]) => {
              lines.push(`- ${label}: ${score}/100${rationale ? ` — ${rationale}` : ''}`);
            });
          }

          if (report.insiderLanguageFlags.length > 0) {
            lines.push('');
            lines.push(`Insider Language Flagged (${report.insiderLanguageFlags.length})`);
            report.insiderLanguageFlags.forEach(flag => {
              const timestamp = flag.minutes_in !== null ? ` (${Math.round(flag.minutes_in)}m in)` : '';
              lines.push(`- “${flag.phrase}”${timestamp}${flag.explanation ? ` — ${flag.explanation}` : ''}`);
            });
          }

          if (report.questionGaps.length > 0) {
            lines.push('');
            lines.push(`Unanswered Questions (${report.questionGaps.length})`);
            report.questionGaps.forEach(gap => {
              const timestamp = gap.question_minutes_in !== null
                ? ` (${Math.round(gap.question_minutes_in)}m in)`
                : '';
              lines.push(`- “${gap.question_text}”${timestamp}${gap.explanation ? ` — ${gap.explanation}` : ''}`);
            });
          }
        }
      }

      lines.push('');
      lines.push('='.repeat(60));
      lines.push('Generated by ARIA — CertaPro Grand Haven');

      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${displayTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-feedback-summary.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSummaryDownloadLoading(false);
    }
  }

  // Extract just the "ACTION ITEMS" section out of the generated summary text
  // so Troy can drop it straight into the CRM without the full write-up.
  function extractActionItems(summaryText: string): string | null {
    if (!summaryText) return null;
    const lines = summaryText.split('\n');
    const startIdx = lines.findIndex(l => /action items/i.test(l));
    if (startIdx === -1) return null;
    const rest = lines.slice(startIdx + 1);
    // Stop at the next numbered section heading (e.g. "6. NEXT STEPS") or a
    // blank-line-delimited end of section — whichever comes first.
    const endIdx = rest.findIndex(l => /^\s*\d+\.\s+[A-Z]/.test(l));
    const body = (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n').trim();
    return body || null;
  }

  function handleDownloadActionItems() {
    if (!meeting) return;
    const activeSummary = summary || meeting.summary || '';
    const actionItems = extractActionItems(activeSummary);
    if (!actionItems) {
      alert('No action items found in the summary yet.');
      return;
    }
    const displayTitle = title || meeting.customer_name || 'Meeting';
    const meetingDate = new Date(meeting.started_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });

    const lines: string[] = [];
    lines.push(`ACTION ITEMS — ${displayTitle}`);
    lines.push(`${meeting.customer_name} · ${meetingDate}`);
    lines.push('');
    lines.push(actionItems);

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${displayTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-action-items.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleGenerateSummary() {
    if (!meetingId) return;
    setSummaryLoading(true);
    try {
      const res = await apiFetch(`/api/meetings/${meetingId}/summary`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error);
      }
      const data = await res.json();
      setSummary(data.summary);
      setMeeting(prev => prev ? { ...prev, summary: data.summary } : prev);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setSummaryLoading(false);
    }
  }

  // ─── Speaker label helpers ────────────────────────────────────────────────

  function getDisplayLabel(rawSpeaker: string): string {
    return speakerLabels[rawSpeaker] || rawSpeaker;
  }

  function handleSpeakerLabelChange(rawSpeaker: string, label: string) {
    const next = { ...speakerLabels, [rawSpeaker]: label };
    setSpeakerLabels(next);
    // Persist to DB so labels survive navigation and appear in downloads
    if (meetingId) {
      updateMeeting(meetingId, { speaker_labels: next }).catch(() => {});
    }
  }

  // ── Live rebuttal teleprompter dismiss handler (2026-08-18 2nd pass) ────
  // Optimistic local remove (rep expects the card to disappear instantly on
  // tap) + persist server-side so the dismissal sticks for the rest of the
  // meeting (per this task's explicit requirement) even across a socket
  // reconnect. Failure to persist is swallowed (not surfaced to the rep) —
  // worst case on a network blip is the same objection could re-fire later
  // in the call, which is a minor annoyance, not a meeting-breaking failure,
  // consistent with this feature's "never break the meeting" degrade rule.
  function dismissLibraryRebuttalPrompt(objectionId: string) {
    setLibraryRebuttalPrompts((prev) => {
      if (!prev.has(objectionId)) return prev;
      const next = new Map(prev);
      next.delete(objectionId);
      return next;
    });
    if (meetingId) {
      dismissLibraryRebuttal(meetingId, objectionId).catch(() => {});
    }
  }

  // ── Mid-call name-introduction confirmation handlers (2026-08-10) ────────
  // The server emitted a `speaker_lock_suggestion` (a GUESS). These POST the
  // user's answer to /api/meetings/:id/speaker-lock. Confirm commits the lock
  // server-side (which then broadcasts the existing `speaker_lock` message,
  // relabeling every synced client); reject tells the server to keep listening
  // for a better candidate without locking. `name` on confirm may be edited.
  async function confirmSpeakerSuggestion(speakerId: string, name: string) {
    if (!meetingId || !name.trim()) return;
    setSpeakerSuggestionBusy(true);
    try {
      const res = await apiFetch(`/api/meetings/${meetingId}/speaker-lock`, {
        method: 'POST',
        body: JSON.stringify({ speakerId, action: 'confirm', name: name.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || 'Failed to confirm');
      }
      // The server broadcasts `speaker_lock` on success, which drives the
      // relabel + toast via applyLiveMessage(); nothing else to do here.
      setSpeakerSuggestion(null);
    } catch {
      // Leave the popup open so the user can retry; a transient failure
      // shouldn't silently drop the guess.
    } finally {
      setSpeakerSuggestionBusy(false);
    }
  }

  async function rejectSpeakerSuggestion(speakerId: string, name: string) {
    setSpeakerSuggestion(null); // optimistic dismiss — they said No
    if (!meetingId) return;
    try {
      await apiFetch(`/api/meetings/${meetingId}/speaker-lock`, {
        method: 'POST',
        body: JSON.stringify({ speakerId, action: 'reject', name }),
      });
    } catch {
      // Best-effort; if the reject POST fails the server just keeps its
      // suggestion pending and may re-suggest after its cooldown.
    }
  }

  // Collect unique speaker keys from segments
  // 2026-08-18: filter out lapse-notice pseudo-segments (speaker: '') so
  // they never show up as a renameable "speaker" in the Rename Speakers list.
  const uniqueSpeakers = Array.from(new Set(segments.filter(s => !s.kind).map(s => s.speaker)));

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-200 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!meeting) return null;

  const isActive = meeting.status === 'active';
  // 2026-08-05 (live meeting sync full-page rebuild): permissive default
  // (true) when omitted, mirroring server.js's own NULL-owner_session_id
  // permissiveness — see shapeMeetingForClient(). This is the ONE flag
  // this whole page branches on to distinguish "my own web meeting" from
  // "observing a mobile meeting"; every other render path below is shared.
  const isOwnerSession = meeting.is_owner_session !== false;
  // Small distinguishing element (see this task's report, open question 7,
  // for the reasoning on why a minimal indicator like this is worth
  // keeping despite the "almost identical" requirement): a rep must be able
  // to tell at a glance that THEIR mic is not live and tapping around
  // this page won't start/stop anything audio-related on this device.
  const isSyncedFromMobile = isActive && !isOwnerSession;

  // 2026-08-17 (ARIA meeting UI by type) — THE discriminator this task's
  // diagnose-before-building step asked for. `meeting.channel === 'phone'`
  // ALONE is not enough: mobile also writes channel='phone' for its own
  // local-mic-capture phone-call meetings (see mobile/src/app/meeting-
  // setup.tsx), which have NO Twilio call behind them at all — those must
  // keep today's in-person-shaped behavior (functional End Meeting, no
  // server recording indicator to show). The one field that is ONLY ever
  // set on a real Twilio-bridged call is `call_sid` (written by
  // findOrCreatePhoneMeeting() in server/telephony.js, for both the
  // outbound "Aria calls the rep" flow and the inbound /telephony/voice
  // webhook) — so `channel === 'phone' && !!call_sid` is the compound
  // check that actually means "this meeting is a live Twilio call with
  // server-side dual-channel recording", which is what both Part 1 and
  // Part 2 need to branch on. Flagged in this task's report: if mobile
  // gains its own Twilio-bridged calling path in the future, this same
  // compound check keeps working with zero changes here.
  const isTwilioPhoneCall = meeting.channel === 'phone' && !!meeting.call_sid;
  const isThisBrowserCall = !!meetingId && browserCall.meetingId === meetingId;

  return (
    <div className={isActive ? 'active-meeting-page bg-gray-200 flex flex-col' : 'min-h-screen bg-gray-200 flex flex-col'}>
      {/* Recording banner — owner-only; an observer session never captures
          audio on this device, so "keep screen on" would be misleading
          (this page's wake lock is only ever acquired by startRecording(),
          which an observer session never calls). See the synced-status
          banner just below for the observer's equivalent. */}
      {isRecording && (
        <div className="bg-red-600 text-white text-center py-2 px-4 text-sm font-semibold animate-pulse sticky top-0 z-50">
          🔴 RECORDING — keep screen on
        </div>
      )}

      {/* Synced-from-mobile banner — observer-only equivalent of the
          recording banner above. Distinguishing element per this task's
          open question 7: makes it unmistakable that the live transcript
          below is arriving from the phone, not this browser's mic. */}
      {isSyncedFromMobile && (
        <div className="bg-indigo-600 text-white text-center py-2 px-4 text-sm font-semibold sticky top-0 z-50">
          📱 LIVE — synced from mobile device
        </div>
      )}

      {/* Voice identification toast */}
      {voiceToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-full shadow-lg">
          {voiceToast}
        </div>
      )}

      {/* Mid-call name-introduction confirmation popup (2026-08-10). Asks the
          user to confirm/edit/reject a guessed speaker name before it locks. */}
      {speakerSuggestion && (
        <SpeakerSuggestionModal
          speakerId={speakerSuggestion.speakerId}
          name={speakerSuggestion.name}
          busy={speakerSuggestionBusy}
          onConfirm={(editedName) => confirmSpeakerSuggestion(speakerSuggestion.speakerId, editedName)}
          onReject={() => rejectSpeakerSuggestion(speakerSuggestion.speakerId, speakerSuggestion.name)}
        />
      )}

      <AppHeader
        title={meeting.title || meeting.customer_name || 'Meeting'}
        subtitle={
          isRecording
            ? `Recording · ${formatElapsed(elapsedSec)}`
            : isSyncedFromMobile
              ? `Synced from mobile · ${formatDuration(meeting.started_at)}`
              : isActive
                ? `Active · ${formatDuration(meeting.started_at)}`
                : `Completed · ${formatDuration(meeting.started_at, meeting.ended_at ?? undefined)}`
        }
        backTo="/"
        toneClassName={isRecording ? 'bg-red-700' : isSyncedFromMobile ? 'bg-indigo-700' : isActive ? 'bg-green-700' : 'bg-blue-700'}
        status={isActive ? (
          <ConnectionBadge status={connectionStatus} isRecording={isRecording || isSyncedFromMobile} />
        ) : undefined}
      />

      {/* Active meetings use a viewport-bounded three-column workspace on
          laptop/desktop. The 46rem center track preserves the pre-existing
          uploaded-recording ARIA panel's 736px rendered width and exact
          viewport-centered x position (max-w-3xl minus its 16px gutters).
          Component styling is intentionally untouched, so its intrinsic
          height and internal dimensions remain unchanged too. */}
      <main
        data-active-meeting-layout={isActive ? 'three-column' : undefined}
        className={isActive ? 'active-meeting-workspace' : 'flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-32'}
      >
        {isActive && (
          <>
            <section
              data-meeting-column="type"
              aria-label={isTwilioPhoneCall ? 'Phone meeting controls' : 'In-person meeting controls'}
              className="active-meeting-column active-meeting-type-column"
            >
              <div className="active-meeting-column-scroll">
                {meetingId && <BrowserCallControls meetingId={meetingId} />}

                <div className="flex flex-col items-center py-2">
                  {isTwilioPhoneCall ? (
                    <div
                      aria-live="polite"
                      className={`w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg flex items-center justify-center ${
                        phoneRecordingStatus === 'in-progress'
                          ? 'bg-red-600 ring-4 ring-red-300 animate-pulse'
                          : 'bg-gray-400 ring-4 ring-gray-200'
                      }`}
                    >
                      <span className="flex flex-col items-center gap-1 text-center">
                        <span className="text-3xl">{phoneRecordingStatus === 'in-progress' ? '🔴' : '📞'}</span>
                        <span className="text-sm">
                          {phoneRecordingStatus === 'in-progress' ? 'Recording (Twilio)' : 'Waiting to record…'}
                        </span>
                      </span>
                    </div>
                  ) : isSyncedFromMobile ? (
                    <div
                      aria-live="polite"
                      className="w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg bg-indigo-600 ring-4 ring-indigo-300 flex items-center justify-center animate-pulse"
                    >
                      <span className="flex flex-col items-center gap-1 text-center">
                        <span className="text-3xl">📱</span>
                        <span className="text-sm">Live from phone</span>
                      </span>
                    </div>
                  ) : isRecording ? (
                    <div
                      aria-live="polite"
                      className="w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg bg-red-600 ring-4 ring-red-300 flex items-center justify-center animate-pulse"
                    >
                      <span className="flex flex-col items-center gap-1">
                        <span className="text-3xl">🎙️</span>
                        <span className="text-sm">Recording</span>
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={handleStartButton}
                      className="w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg transition-all bg-green-600 hover:bg-green-700 active:scale-95"
                    >
                      <span className="flex flex-col items-center gap-1">
                        <span className="text-3xl">🎙️</span>
                        <span className="text-sm">Record</span>
                      </span>
                    </button>
                  )}
                  {isRecording && (
                    <p className="mt-3 text-2xl font-mono font-bold text-red-700">
                      {formatElapsed(elapsedSec)}
                    </p>
                  )}
                </div>

                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                    {isTwilioPhoneCall ? 'Phone meeting' : 'Live recording'}
                  </h2>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-gray-500">Status</span>
                      <span className={`font-medium text-right ${isTwilioPhoneCall && phoneRecordingStatus !== 'in-progress' ? 'text-gray-600' : 'text-green-700'}`}>
                        {isTwilioPhoneCall
                          ? (phoneRecordingStatus === 'in-progress' ? 'Call recording live' : 'Waiting for answer')
                          : isSyncedFromMobile ? 'Synced from mobile' : isRecording ? 'Microphone recording live' : 'Ready to record'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-gray-500">Started</span>
                      <span className="text-gray-700 text-right">
                        {new Date(meeting.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {meeting.customer_name && (
                      <div className="flex justify-between gap-2">
                        <span className="text-gray-500">Customer</span>
                        <span className="text-gray-700 text-right">{meeting.customer_name}</span>
                      </div>
                    )}
                    {meeting.origin_client === 'mobile' && (
                      <div className="flex justify-between gap-2">
                        <span className="text-gray-500">Source</span>
                        <span className="text-gray-700 text-right">📱 Mobile</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {!isThisBrowserCall && isOwnerSession && (
                <div data-meeting-end-control className="active-meeting-end-control">
                  {isTwilioPhoneCall ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className="w-full bg-gray-100 border border-gray-200 text-gray-500 font-semibold py-3 rounded-2xl text-base text-center select-none"
                    >
                      <span className="block">📞 Hang Up</span>
                      <span className="block text-xs font-normal text-gray-400 mt-1">
                        Hang up your phone to end this meeting.
                      </span>
                    </div>
                  ) : (
                    <button
                      onClick={handleEndMeetingButtonClick}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-4 rounded-2xl text-lg transition-colors"
                    >
                      ⏹ End Meeting
                    </button>
                  )}
                </div>
              )}
            </section>

            <section
              data-meeting-column="feedback"
              aria-label="ARIA Feedback"
              className="active-meeting-feedback-column"
            >
              <div data-aria-feedback-panel className="w-full">
                {suggestedRebuttal && (
                  <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 flex items-start gap-3 mb-4">
                    <span className="text-2xl">💬</span>
                    <div className="flex-1">
                      <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-1">
                        Suggested rebuttal · {suggestedRebuttal.objectionCategory}
                      </p>
                      <p className="text-sm text-indigo-900 font-medium">{suggestedRebuttal.rebuttal}</p>
                    </div>
                    <button
                      onClick={() => setSuggestedRebuttal(null)}
                      aria-label="Dismiss suggested rebuttal"
                      className="text-indigo-400 hover:text-indigo-600 text-sm"
                    >
                      ✕
                    </button>
                  </div>
                )}
                <RebuttalTeleprompter
                  prompts={Array.from(libraryRebuttalPrompts.values())}
                  onDismiss={dismissLibraryRebuttalPrompt}
                />
                <CoachingPanel
                  coaching={coachingData ? {
                    ...coachingData,
                    checklist: coachingData.checklist?.map(item => ({
                      ...item,
                      done: item.done || lockedChecked.has(item.id),
                    })) ?? [],
                  } : null}
                  defaultCollapsed={false}
                />
              </div>
            </section>

            <section
              data-meeting-column="transcript"
              aria-label="Speaker and transcript controls"
              className="active-meeting-column active-meeting-transcript-column"
            >
              <div data-speaker-controls className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex-none">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                  Rename Speakers
                </h2>
                {uniqueSpeakers.length > 0 ? (
                  <div className="space-y-2">
                    {uniqueSpeakers.map(sp => (
                      <div key={sp} className="flex items-center gap-2">
                        <span className="text-sm text-gray-500 w-20 flex-shrink-0 truncate">{sp}</span>
                        <input
                          aria-label={`Rename ${sp}`}
                          type="text"
                          placeholder={`Rename ${sp}`}
                          value={speakerLabels[sp] || ''}
                          onChange={e => handleSpeakerLabelChange(sp, e.target.value)}
                          className="min-w-0 flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Speaker names appear here as the transcript grows.</p>
                )}
              </div>

              <div data-live-transcript className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex min-h-0 flex-1 flex-col">
                <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3 flex-none">
                  Live Transcript
                </h2>
                <div
                  ref={transcriptContainerRef}
                  onScroll={handleTranscriptScroll}
                  aria-label="Live Transcript content"
                  aria-live="polite"
                  className="active-transcript-scroll space-y-2"
                >
                  {segments.length === 0 && !interimText ? (
                    <p className="text-sm text-gray-400 text-center py-4">
                      {isSyncedFromMobile
                        ? 'Waiting for live transcript from phone…'
                        : isTwilioPhoneCall
                          ? (phoneRecordingStatus === 'in-progress' ? 'Listening…' : 'Waiting for the customer to answer…')
                          : isRecording ? 'Listening…' : 'Start recording to see live transcript'}
                    </p>
                  ) : (
                    <>
                      {segments.map((seg, i) => (
                        seg.kind ? (
                          <TranscriptLapseNotice key={`${seg.ts ?? i}-${seg.kind}`} seg={seg} />
                        ) : (
                          <div key={seg.id ?? `${seg.ts ?? i}-${seg.speaker}-${seg.text}`} className="text-sm">
                            <span className="font-semibold text-blue-700">{getDisplayLabel(seg.speaker)}:</span>{' '}
                            <span className="text-gray-800">{seg.text}</span>
                          </div>
                        )
                      ))}
                      {interimText && (
                        <div className="text-sm">
                          <span className="font-semibold text-gray-400">{getDisplayLabel(interimSpeaker || 'Speaker')}:</span>{' '}
                          <span className="text-gray-400 italic">{interimText}</span>
                        </div>
                      )}
                      <div ref={transcriptEndRef} />
                    </>
                  )}
                </div>
              </div>
            </section>
          </>
        )}

        {/* ── Post-meeting view ── */}
        {!isActive && (
          <>
            {/* Full transcript */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Transcript
              </h3>

              {segments.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">
                  No transcript recorded.
                </p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {segments.map((seg, i) => (
                    // 2026-08-09: see live-view comment above — same real-id
                    // preference, same genuine fallback edge case. 2026-08-18:
                    // same lapse-notice rendering as the live view above, so
                    // the post-meeting record still shows where a lapse
                    // occurred.
                    seg.kind ? (
                      <TranscriptLapseNotice key={`${seg.ts ?? i}-${seg.kind}`} seg={seg} />
                    ) : (
                    <div key={seg.id ?? `${seg.ts ?? i}-${seg.speaker}-${seg.text}`} className="text-sm">
                      <span className="font-semibold text-blue-700">
                        {getDisplayLabel(seg.speaker)}:
                      </span>{' '}
                      <span className="text-gray-800">{seg.text}</span>
                    </div>
                    )
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>

            {/* Speaker label editor */}
            {uniqueSpeakers.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                  Rename Speakers
                </h3>
                <div className="space-y-2">
                  {uniqueSpeakers.map(sp => (
                    <div key={sp} className="flex items-center gap-2">
                      <span className="text-sm text-gray-500 w-24 flex-shrink-0">{sp}</span>
                      <input
                        type="text"
                        placeholder={`Rename ${sp}`}
                        value={speakerLabels[sp] || ''}
                        onChange={e => handleSpeakerLabelChange(sp, e.target.value)}
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Editable Title */}
            <MeetingTitleEditor
              value={title}
              savedValue={meeting.title}
              placeholder={meeting.customer_name || 'Add a title…'}
              saving={titleSaving}
              error={titleError}
              onChange={value => {
                setTitle(value);
                setTitleError(null);
              }}
              onSave={handleSaveTitle}
            />

            {/* Post-meeting analytics: WPM, checklist timing, Meeting Score */}
            {!isActive && meetingId && <MeetingScoreCard meetingId={meetingId} />}

            {/* ARIA Priority 1 roadmap: BANT/closing certainty, insider-language
                flags, question-listening gaps, aggregate coaching report */}
            {!isActive && meetingId && <CoachingReportCard meetingId={meetingId} />}

            {/* Summary */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Meeting Summary
              </h3>

              {summary || meeting.summary ? (
                <>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap mb-4">
                    {(summary || meeting.summary || '').replace(/\*/g, '')}
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={handleDownloadSummary}
                      disabled={summaryDownloadLoading}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                    >
                      <span>⬇️</span> {summaryDownloadLoading ? 'Preparing…' : 'Download Feedback & Summary'}
                    </button>
                    <button
                      onClick={handleDownloadTranscript}
                      className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                    >
                      <span>⬇️</span> Download Transcript
                    </button>
                    {extractActionItems(summary || meeting.summary || '') && (
                      <button
                        onClick={handleDownloadActionItems}
                        className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                      >
                        <span>✅</span> Download Action Items
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-3">
                    No summary generated yet.
                  </p>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={summaryLoading || segments.length === 0}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
                  >
                    {summaryLoading ? 'Generating…' : '✨ Generate Summary'}
                  </button>
                  {segments.length === 0 && (
                    <p className="text-xs text-gray-400 mt-2 text-center">
                      No transcript to summarize.
                    </p>
                  )}
                  {segments.length > 0 && (
                    <button
                      onClick={handleDownloadTranscript}
                      className="w-full mt-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                    >
                      <span>⬇️</span> Download Transcript
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* Meeting details */}
        {!isActive && <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
            Details
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className={`font-medium capitalize ${isActive ? 'text-green-700' : 'text-gray-700'}`}>
                {meeting.status}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Started</span>
              <span className="text-gray-700">
                {new Date(meeting.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {meeting.ended_at && (
              <div className="flex justify-between">
                <span className="text-gray-500">Ended</span>
                <span className="text-gray-700">
                  {new Date(meeting.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
            {meeting.customer_name && (
              <div className="flex justify-between">
                <span className="text-gray-500">Customer</span>
                <span className="text-gray-700">{meeting.customer_name}</span>
              </div>
            )}
            {/* 2026-08-05 (live meeting sync full-page rebuild): small,
                low-key indicator of which device started this meeting —
                shown for EVERY meeting (not just synced ones) since it's
                genuinely just a details row, not a special-cased banner. */}
            {meeting.origin_client === 'mobile' && (
              <div className="flex justify-between">
                <span className="text-gray-500">Source</span>
                <span className="text-gray-700">📱 Mobile</span>
              </div>
            )}
          </div>
        </div>}
      </main>

      {/* Bottom action */}
      {/* 2026-08-05 (live meeting sync full-page rebuild) — HARD REQUIREMENT
          carried over from the popup this replaces (Gabe/Troy, verbatim:
          "the meeting should only be able to be ended on the device that
          started the meeting in the first place"): an observer session
          renders NO End Meeting button at all here — not a disabled one,
          not one with a client-side guard, NONE. There is no code path in
          this branch that could even attempt to call handleEndMeeting() for
          an observer. The actual enforcement (the part that matters even if
          this UI branch had a bug) is server-side: PATCH /api/meetings/:id's
          owner_session_id check in server.js, unchanged by this rework —
          see this task's report for a real HTTP test proving a synced
          session's direct PATCH attempt is still rejected with 403 even
          bypassing this UI entirely. Observer sessions get a plain
          "← Back to Home" instead, same as the post-meeting view every
          session sees once the mobile device ends the meeting. */}
      {!isActive && !isThisBrowserCall && <div
          className="fixed bottom-0 left-0 right-0 px-4 pb-4 bg-white border-t border-gray-100 shadow-lg"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        >
        {isActive && isOwnerSession && isTwilioPhoneCall ? (
          // 2026-08-17 (ARIA meeting UI by type, Part 2) — Gabe, verbatim:
          // "For phone calls I want the end meeting button to say hang up to
          // end the meeting and just make it visual and not functional. Make
          // sure this doesn't mess up the in-person version that needs this
          // button to be functional." The rep ends a phone meeting by
          // hanging up the ACTUAL phone — Twilio's status-callback webhook
          // (server/telephony.js's /telephony/status-callback, unchanged
          // logic, now also broadcasts 'meeting_ended' live — see that
          // file) is what finalizes the meeting row when that happens, not
          // this button. Rendered as a plain <div>, not a <button>: no
          // onClick, no hover/active states, no button semantics at all —
          // deliberately non-actionable rather than a tappable-looking dead
          // button (the "UX smell" this task explicitly flagged). Paired
          // with an explicit one-line hint so a rep isn't left wondering why
          // nothing happens if they do tap it.
          <div
            role="status"
            aria-live="polite"
            className="w-full bg-gray-100 border border-gray-200 text-gray-500 font-semibold py-4 rounded-2xl text-lg text-center select-none"
          >
            <span className="block">📞 Hang Up</span>
            <span className="block text-xs font-normal text-gray-400 mt-1">
              Hang up your phone to end this meeting.
            </span>
          </div>
        ) : isActive && isOwnerSession ? (
          <button
            onClick={handleEndMeetingButtonClick}
            className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-4 rounded-2xl text-lg transition-colors"
          >
            ⏹ End Meeting
          </button>
        ) : (
          <button
            onClick={() => navigate('/')}
            className="w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-4 rounded-2xl text-lg transition-colors"
          >
            ← Back to Home
          </button>
        )}
        </div>}

      {/* Consent modal */}
      {showConsentPrompt && (
        <ConsentModal
          onConfirm={handleConsentConfirm}
          onCancel={() => setShowConsentPrompt(false)}
        />
      )}

      {/* End Meeting confirmation modal — only shown when ending while
          actively recording (see handleEndMeetingButtonClick()). Confirm
          reuses the existing merged handleEndMeeting() handler as-is; Cancel
          just dismisses with no side effects and recording continues. */}
      {showEndMeetingConfirm && (
        <EndMeetingConfirmModal
          onConfirm={() => {
            setShowEndMeetingConfirm(false);
            handleEndMeeting();
          }}
          onCancel={() => setShowEndMeetingConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── SpeakerSuggestionModal ───────────────────────────────────
// Confirmation popup for a mid-call name-introduction guess. "We think
// Speaker 2 is John — is that right?" with Yes / edit-then-Yes / No. Nothing is
// locked until the user confirms (see confirmSpeakerSuggestion). The name is
// pre-filled into an editable field so "Yes, but it's spelled Jon" is one tap.
function SpeakerSuggestionModal({
  speakerId,
  name,
  busy,
  onConfirm,
  onReject,
}: {
  speakerId: string;
  name: string;
  busy: boolean;
  onConfirm: (editedName: string) => void;
  onReject: () => void;
}) {
  const [edited, setEdited] = useState(name);
  // Re-seed the field if the server sends a fresh guess while the popup is up.
  useEffect(() => { setEdited(name); }, [name]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <div className="text-center mb-4">
          <div className="text-4xl mb-2">👋</div>
          <h2 className="text-lg font-bold text-gray-900">Is this {speakerId}?</h2>
          <p className="text-sm text-gray-600 mt-1">
            We heard an introduction and think this speaker is:
          </p>
        </div>
        <input
          type="text"
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          disabled={busy}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-center text-lg font-semibold text-gray-900 mb-5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          onKeyDown={(e) => { if (e.key === 'Enter' && edited.trim() && !busy) onConfirm(edited.trim()); }}
          autoFocus
        />
        <div className="flex gap-3">
          <button
            onClick={onReject}
            disabled={busy}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors disabled:opacity-60"
          >
            No, not them
          </button>
          <button
            onClick={() => onConfirm(edited.trim())}
            disabled={busy || !edited.trim()}
            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Yes, that’s right'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EndMeetingConfirmModal ─────────────────────────────────────────────────

function EndMeetingConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <div className="text-center mb-4">
          <div className="text-4xl mb-2">⏹</div>
          <h2 className="text-lg font-bold text-gray-900">End this meeting?</h2>
        </div>
        <p className="text-sm text-gray-600 text-center mb-5">
          This will stop recording and finalize the meeting.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
          >
            ⏹ End Meeting
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConnectionBadge ──────────────────────────────────────────────────────────

function ConnectionBadge({
  status,
  isRecording,
}: {
  status: ConnectionStatus;
  isRecording: boolean;
}) {
  if (!isRecording) return null;

  const map: Record<ConnectionStatus, { label: string; color: string }> = {
    connected: { label: 'Connected', color: 'bg-green-500' },
    connecting: { label: 'Connecting…', color: 'bg-yellow-400' },
    reconnecting: { label: 'Reconnecting…', color: 'bg-orange-400' },
    disconnected: { label: 'Disconnected', color: 'bg-gray-400' },
  };

  const { label, color } = map[status];

  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${color} text-white px-2 py-1 rounded-full`}>
      <span className={`w-1.5 h-1.5 bg-white rounded-full ${status === 'connected' ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}

// ─── ConsentModal ─────────────────────────────────────────────────────────────

function ConsentModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <div className="text-center mb-4">
          <div className="text-4xl mb-2">🎙️</div>
          <h2 className="text-lg font-bold text-gray-900">Consent Required</h2>
        </div>
        <p className="text-sm text-gray-600 mb-2 text-center">
          Before recording, please inform your customer:
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
          <p className="text-sm text-blue-800 font-medium text-center italic">
            "I'd like to record this conversation so I can provide you with accurate notes
            and follow-up. Is that okay with you?"
          </p>
        </div>
        <p className="text-xs text-gray-400 text-center mb-4">
          Tap Confirm only after informing your customer. This confirmation will be logged.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
          >
            ✅ Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
