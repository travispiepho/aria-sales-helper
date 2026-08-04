import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMeeting, updateMeeting, getMeetingSegments, getLatestCoaching, Meeting, apiFetch } from '../lib/api';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';
import MeetingScoreCard from '../components/MeetingScoreCard';

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

// Derive a WS URL from VITE_API_URL (production) or current location (dev)
function getWsBase(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    // Convert https://host to wss://host, http://host to ws://host
    return apiUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  }
  // Dev fallback: Vite proxies HTTP but WS hits backend directly on :3000
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://localhost:3000`;
}

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
      stopRecording();
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

  // ─── WebSocket connection ─────────────────────────────────────────────────

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
        const msg = JSON.parse(evt.data as string);
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
          const { speakerId } = msg as { type: string; speakerId: string };
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
        }
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

  // ─── End meeting ──────────────────────────────────────────────────────────

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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Recording banner */}
      {isRecording && (
        <div className="bg-red-600 text-white text-center py-2 px-4 text-sm font-semibold animate-pulse sticky top-0 z-50">
          🔴 RECORDING — keep screen on
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
        className={`px-4 pt-4 pb-5 ${isRecording ? 'bg-red-700' : isActive ? 'bg-green-700' : 'bg-blue-700'} text-white`}
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
                : isActive
                  ? `Active · ${formatDuration(meeting.started_at)}`
                  : `Completed · ${formatDuration(meeting.started_at, meeting.ended_at ?? undefined)}`}
            </p>
          </div>
          {/* Connection status indicator */}
          {isActive && (
            <ConnectionBadge status={connectionStatus} isRecording={isRecording} />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 pb-32">

        {/* ── Active meeting: Record controls ── */}
        {isActive && (
          <>
            {/* Big Record button */}
            <div className="flex flex-col items-center py-6">
              <button
                onClick={isRecording ? stopRecording : handleStartButton}
                className={`w-32 h-32 rounded-full shadow-lg text-white font-bold text-lg transition-all
                  ${isRecording
                    ? 'bg-red-600 hover:bg-red-700 active:scale-95 ring-4 ring-red-300'
                    : 'bg-green-600 hover:bg-green-700 active:scale-95'
                  }`}
              >
                {isRecording ? (
                  <span className="flex flex-col items-center gap-1">
                    <span className="text-3xl">⏹</span>
                    <span className="text-sm">Stop</span>
                  </span>
                ) : (
                  <span className="flex flex-col items-center gap-1">
                    <span className="text-3xl">🎙️</span>
                    <span className="text-sm">Record</span>
                  </span>
                )}
              </button>
              {isRecording && (
                <p className="mt-3 text-2xl font-mono font-bold text-red-700">
                  {formatElapsed(elapsedSec)}
                </p>
              )}
            </div>

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
                  {isRecording ? 'Listening…' : 'Start recording to see live transcript'}
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
          </div>
        </div>
      </div>

      {/* Bottom action */}
      <div
        className="fixed bottom-0 left-0 right-0 px-4 pb-4 bg-white border-t border-gray-100 shadow-lg"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        {isActive ? (
          <button
            onClick={handleEndMeeting}
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
