import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getMeeting, updateMeeting, getMeetingSegments, Meeting, apiFetch } from '../lib/api';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';

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

  // Post-meeting
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
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
    ])
      .then(([m, { segments: saved }]) => {
        setMeeting(m);
        setTitle(m.title || m.customer_name || '');
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
        } else if (msg.type === 'coaching' && msg.data) {
          // Phase 3: real-time coaching update
          setCoachingData(msg.data as CoachingData);
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
    setSpeakerLabels(prev => ({ ...prev, [rawSpeaker]: label }));
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
            <CoachingPanel coaching={coachingData} defaultCollapsed={false} />

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

            {/* Summary */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Meeting Summary
              </h3>

              {summary || meeting.summary ? (
                <p className="text-sm text-gray-800 whitespace-pre-wrap">
                  {summary || meeting.summary}
                </p>
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
