import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMeeting, updateMeeting, getMeetingSegments, getLatestCoaching, Meeting, apiFetch } from '../lib/api';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';
import MeetingScoreCard from '../components/MeetingScoreCard';
import CoachingReportCard from '../components/CoachingReportCard';
import { getWsBase } from '../lib/wsBase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptSegment {
  id?: string;
  speaker: string;
  text: string;
  isFinal: boolean;
  ts?: number;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(startIso: string, endIso?: string): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return formatElapsed(Math.floor((end - start) / 1000));
}

// getWsBase() moved to lib/wsBase.ts (2026-08-05, live meeting sync
// full-page rebuild) so useMeetingSyncWatcher.ts can share the exact same
// derivation logic without a second copy — see that file's own header for
// why. Behavior is byte-for-byte identical to what lived here before.

// ─── Component ────────────────────────────────────────────────────────────────

export default function MeetingPage() {
  const { id: meetingId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Meeting state
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');

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
  const [exportingDoc, setExportingDoc] = useState(false);
  const [voiceToast, setVoiceToast] = useState<string | null>(null);
  // ARIA Priority 1 roadmap, item 5: Live rebuttal teleprompter. Handles the
  // "suggested_rebuttal" WS message pushed by server.js's STUB objection
  // detector + REAL Claude-generated rebuttal (see objectionDetection.js /
  // coachingAnalysis.js's generateRebuttal() for the real-vs-stubbed
  // breakdown). This is a first-pass UI: a dismissible banner, not yet a
  // polished "teleprompter" UX — intentionally minimal per task scope.
  const [suggestedRebuttal, setSuggestedRebuttal] = useState<{ objectionCategory: string; rebuttal: string } | null>(null);
  const [title, setTitle] = useState<string>('');
  const [titleSaving, setTitleSaving] = useState(false);

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

  // ─── Load meeting ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId) return;
    Promise.all([
      getMeeting(meetingId),
      getMeetingSegments(meetingId),
      getLatestCoaching(meetingId),
    ])
      .then(([m, { segments: saved }, { coaching }]) => {
        setMeeting(m);
        setTitle(m.title || m.customer_name || '');
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
            speaker: s.speaker,
            text: s.text,
            isFinal: true,
            ts: new Date(s.ts).getTime(),
          })));
        }
      })
      .catch(() => navigate('/'))
      .finally(() => setLoading(false));
  }, [meetingId, navigate]);

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
            speaker: msg.speaker || 'Speaker',
            text: msg.text,
            isFinal: true,
            ts: Date.now(),
          },
        ]);
      }
    } else if (msg.type === 'speaker_lock') {
      // Voice fingerprint matched — auto-label the rep's speaker ID
      const { speakerId, name } = msg as { type: string; speakerId: string; name: string };
      handleSpeakerLabelChange(speakerId, name);
      setVoiceToast(`🎙️ ${name} identified`);
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
    } else if (msg.type === 'suggested_rebuttal') {
      // Live rebuttal teleprompter (item 5) — first-pass scaffolding.
      const { objectionCategory, rebuttal } = msg as { type: string; objectionCategory: string; rebuttal: string };
      setSuggestedRebuttal({ objectionCategory, rebuttal });
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
    } else if (msg.type === 'meeting_ended') {
      // Observer-only in practice (the owner learns the meeting ended via its
      // own updateMeeting() response, not this message) — the mobile device
      // finalized the meeting (End Meeting tap, or server-side
      // finalizeMeetingIfAbandoned() on a dropped connection). Re-fetch so
      // this page flips from the live "Active meeting" branch to the
      // post-meeting branch with the final status/ended_at from the server,
      // same as if the owner's own handleEndMeeting() had run locally.
      if (meetingId) {
        getMeeting(meetingId).then(setMeeting).catch(() => {});
      }
    }
  }, [meetingId]);

  // ─── WebSocket connection (owner: audio streaming) ───────────────────────

  const connectWebSocket = useCallback(() => {
    if (!meetingId) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionStatus('connecting');

    const wsUrl = `${getWsBase()}/meetings/${meetingId}/audio`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;

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
      // Auto-reconnect with exponential backoff, cap at 30s buffer
      setConnectionStatus('reconnecting');
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 10000);
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (isRecordingRef.current) {
          connectWebSocket();
        }
      }, delay);
    };
  }, [meetingId]);

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

    ws.onopen = () => {
      setConnectionStatus('connected');
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
      if (isActiveRef.current && !isOwnerSessionRef.current) {
        observeReconnectTimerRef.current = setTimeout(connectObserverSocket, 3000);
      }
    };
  }, [meetingId, applyLiveMessage]);

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

    if (active && !owner) {
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
      setMeeting(updated);
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
    if (!meetingId || !title.trim()) return;
    setTitleSaving(true);
    try {
      const updated = await updateMeeting(meetingId, { title: title.trim() });
      setMeeting(prev => prev ? { ...prev, title: updated.title } : prev);
    } catch {
      // silent fail
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

  async function handleExportToDocs() {
    if (!meetingId) return;
    setExportingDoc(true);
    try {
      const res = await apiFetch(`/api/meetings/${meetingId}/export-to-docs`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error);
      }
      const data = await res.json();
      if (data.webViewLink) {
        window.open(data.webViewLink, '_blank');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to export to Google Docs');
    } finally {
      setExportingDoc(false);
    }
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

  // Collect unique speaker keys from segments
  const uniqueSpeakers = Array.from(new Set(segments.map(s => s.speaker)));

  // ─── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
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

      {/* Header */}
      <div
        className={`px-4 pt-4 pb-5 ${isRecording ? 'bg-red-700' : isSyncedFromMobile ? 'bg-indigo-700' : isActive ? 'bg-green-700' : 'bg-blue-700'} text-white`}
        style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => navigate('/')}
            className="text-white/70 hover:text-white text-lg"
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-lg truncate">
              {meeting.customer_name || 'Meeting'}
            </h1>
            <p className="text-white/70 text-sm">
              {isRecording
                ? `Recording · ${formatElapsed(elapsedSec)}`
                : isSyncedFromMobile
                  ? `Synced from mobile · ${formatDuration(meeting.started_at)}`
                  : isActive
                    ? `Active · ${formatDuration(meeting.started_at)}`
                    : `Completed · ${formatDuration(meeting.started_at, meeting.ended_at ?? undefined)}`}
            </p>
          </div>
          {/* Connection status indicator — shared badge, works for either
              socket (owner audio or observer) since both drive the same
              connectionStatus state. */}
          {isActive && (
            <ConnectionBadge status={connectionStatus} isRecording={isRecording || isSyncedFromMobile} />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-32">

        {/* ── Active meeting: Record controls ── */}
        {isActive && (
          <>
            {/* Big Record button.
                2026-08-05: while recording this used to be a live "Stop"
                button that called stopRecording() directly — stopping only
                the audio capture without finalizing the meeting record.
                That was the separate "End Recording" action Gabe flagged as
                confusing (memory/2026-08-04.md 23:47 CDT note): a rep could
                stop the mic here and the meeting would just sit "active"
                forever with no obvious next step. Consolidated: the ONLY way
                to stop recording now is the bottom "End Meeting" button,
                which stops the mic AND finalizes the meeting in one action
                (see handleEndMeeting()). While recording, this circle is now
                a non-interactive live-status indicator only (no onClick) —
                same pulsing visual, but it can no longer diverge from the
                meeting's actual lifecycle. */}
            <div className="flex flex-col items-center py-6">
              {isSyncedFromMobile ? (
                // 2026-08-05 (live meeting sync full-page rebuild): observer
                // session — there is nothing to tap here. No Record button
                // (this device has no mic role in this meeting at all), and
                // deliberately NOT the same red "Recording" indicator the
                // owner sees while recording — a phone icon instead, so a
                // rep glancing at this screen can't mistake it for "my own
                // mic is live on this browser" (see this task's report,
                // open question 7, for why this distinguishing element is
                // kept despite the "almost identical" requirement).
                <div
                  aria-live="polite"
                  className="w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg bg-indigo-600 ring-4 ring-indigo-300 flex items-center justify-center animate-pulse"
                >
                  <span className="flex flex-col items-center gap-1">
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

            {/* ARIA Priority 1 roadmap, item 5: Live rebuttal teleprompter
                (first-pass scaffolding — objection detection is a STUB
                keyword matcher, rebuttal text is REAL Claude output. See
                objectionDetection.js / coachingAnalysis.js for details.) */}
            {suggestedRebuttal && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 flex items-start gap-3">
                <span className="text-2xl">💬</span>
                <div className="flex-1">
                  <p className="text-xs font-semibold text-indigo-500 uppercase tracking-wide mb-1">
                    Suggested rebuttal · {suggestedRebuttal.objectionCategory}
                  </p>
                  <p className="text-sm text-indigo-900 font-medium">{suggestedRebuttal.rebuttal}</p>
                </div>
                <button
                  onClick={() => setSuggestedRebuttal(null)}
                  className="text-indigo-400 hover:text-indigo-600 text-sm"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Phase 3: Coaching Panel */}
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

            {/* Live transcript */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Live Transcript
              </h3>

              {segments.length === 0 && !interimText ? (
                <p className="text-sm text-gray-400 text-center py-4">
                  {isSyncedFromMobile ? 'Waiting for live transcript from phone…' : isRecording ? 'Listening…' : 'Start recording to see live transcript'}
                </p>
              ) : (
                <div
                  ref={transcriptContainerRef}
                  onScroll={handleTranscriptScroll}
                  className="space-y-2 max-h-64 overflow-y-auto"
                >
                  {segments.map((seg, i) => (
                    <div key={i} className="text-sm">
                      <span className="font-semibold text-blue-700">
                        {getDisplayLabel(seg.speaker)}:
                      </span>{' '}
                      <span className="text-gray-800">{seg.text}</span>
                    </div>
                  ))}
                  {/* Interim result */}
                  {interimText && (
                    <div className="text-sm">
                      <span className="font-semibold text-gray-400">
                        {getDisplayLabel(interimSpeaker || 'Speaker')}:
                      </span>{' '}
                      <span className="text-gray-400 italic">{interimText}</span>
                    </div>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
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
                    <div key={i} className="text-sm">
                      <span className="font-semibold text-blue-700">
                        {getDisplayLabel(seg.speaker)}:
                      </span>{' '}
                      <span className="text-gray-800">{seg.text}</span>
                    </div>
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
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Meeting Title
              </h3>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onBlur={handleSaveTitle}
                  onKeyDown={e => e.key === 'Enter' && handleSaveTitle()}
                  placeholder={meeting?.customer_name || 'Add a title…'}
                  className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={handleSaveTitle}
                  disabled={titleSaving}
                  className="px-3 py-2 bg-brand-700 hover:bg-brand-800 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
                >
                  {titleSaving ? '…' : 'Save'}
                </button>
              </div>
            </div>

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
                    <button
                      onClick={handleExportToDocs}
                      disabled={exportingDoc}
                      className="w-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-gray-700 font-semibold py-2.5 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                    >
                      <span>📄</span> {exportingDoc ? 'Exporting…' : 'Export to Google Doc'}
                    </button>
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
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
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
        </div>
      </div>

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
      <div
        className="fixed bottom-0 left-0 right-0 px-4 pb-4 bg-white border-t border-gray-100 shadow-lg"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {isActive && isOwnerSession ? (
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
      </div>

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
