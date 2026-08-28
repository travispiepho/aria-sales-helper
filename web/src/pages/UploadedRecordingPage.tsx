import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';
import {
  createUploadedRecordingMeeting,
  getMeeting,
  getMeetingSegments,
  TranscriptSegment,
} from '../lib/api';
import {
  formatRecordingDuration,
  isMp4RecordingFile,
  LocalRecordingPlayer,
  PLAYBACK_RATE,
  recordingDecodeError,
  UPLOADED_RECORDING_ACCEPT,
  UploadedRecordingTransport,
  validateRecordingFile,
} from '../lib/uploadedRecording';

type PlaybackState = 'idle' | 'preparing' | 'playing' | 'paused' | 'stopping' | 'complete' | 'error';

interface LiveSegment extends TranscriptSegment { isFinal?: boolean }

export default function UploadedRecordingPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<PlaybackState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [coaching, setCoaching] = useState<CoachingData | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const playerRef = useRef<LocalRecordingPlayer | null>(null);
  const transportRef = useRef<UploadedRecordingTransport | null>(null);
  const finalizePromiseRef = useRef<Promise<void> | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const active = state === 'preparing' || state === 'playing' || state === 'paused' || state === 'stopping';

  function handleTranscriptScroll() {
    const el = transcriptContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 80;
  }

  useEffect(() => {
    if (userScrolledUpRef.current) return;
    const el = transcriptContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments, interimText]);

  const cleanupResources = useCallback(async (sendEnd = true) => {
    if (sendEnd) transportRef.current?.end();
    transportRef.current?.close();
    transportRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    if (player) await Promise.resolve(player.stop()).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      void cleanupResources(true);
    };
  }, [objectUrl, cleanupResources]);

  function resetSelectedFile(nextFile: File | null) {
    setError(null);
    setDuration(0);
    setConsent(false);
    setProgress(0);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setObjectUrl('');
    setFile(nextFile);
    if (!nextFile) return;
    const validationError = validateRecordingFile(nextFile);
    if (validationError) {
      setError(validationError);
      return;
    }
    const url = URL.createObjectURL(nextFile);
    setObjectUrl(url);
    setMetadataLoading(true);
  }

  function applyLiveMessage(message: unknown) {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'interim') {
      setInterimText(typeof msg.text === 'string' ? msg.text : '');
    } else if (msg.type === 'final') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      setInterimText('');
      if (text) {
        setSegments(previous => [...previous, {
          id: typeof msg.id === 'string' ? msg.id : undefined,
          speaker: typeof msg.speaker === 'string' ? msg.speaker : 'Speaker',
          text,
          ts: new Date().toISOString(),
          isFinal: true,
        }]);
      }
    } else if (msg.type === 'coaching' && msg.data) {
      setCoaching(msg.data as CoachingData);
    } else if (msg.type === 'error') {
      setError(typeof msg.error === 'string' ? msg.error : 'ARIA could not analyze this recording.');
    }
  }

  const finalize = useCallback(async () => {
    if (finalizePromiseRef.current) return finalizePromiseRef.current;
    const id = meetingIdRef.current;
    const task = (async () => {
      setState('stopping');
      const transport = transportRef.current;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) await Promise.resolve(player.stop()).catch(() => {});
      if (!transport || !transport.end()) throw new Error('ARIA playback connection is not available.');
      let completionError: unknown = null;
      let completionAcknowledged = false;
      try {
        await transport.waitForCompletion();
        completionAcknowledged = true;
      } catch (cause) {
        completionError = cause;
      }
      transport.close();
      transportRef.current = null;
      if (!id) {
        if (completionAcknowledged) {
          setError(null);
          setState('complete');
        } else {
          setError(completionError instanceof Error ? completionError.message : 'ARIA could not complete this recording.');
          setState('error');
        }
        return;
      }

      if (completionAcknowledged) {
        // The server only emits `completed` after persisting finalization.
        // MeetingPage can perform its own normal detail/transcript readback;
        // do not let an optional pre-navigation fetch delay or contradict it.
        setError(null);
        setState('complete');
        navigate(`/meetings/${id}`, { replace: true });
        return;
      }

      let latest: Awaited<ReturnType<typeof getMeeting>> | null = null;
      let readbackError: unknown = null;
      try {
        latest = await getMeeting(id);
      } catch (cause) {
        readbackError = cause;
      }

      // Match MeetingPage's completion semantics: `active` is the only live
      // state. A terminal meeting readback is authoritative even if the
      // completion socket closed before its final acknowledgement arrived.
      // Conversely, a received `completed` acknowledgement is authoritative
      // even if this optional readback fails or is briefly stale.
      if (latest && latest.status !== 'active') {
        const saved = await getMeetingSegments(id).catch(() => ({ segments: [] }));
        if (saved.segments.length > 0) setSegments(saved.segments.map(segment => ({ ...segment, isFinal: true })));
        setError(null);
        setState('complete');
        navigate(`/meetings/${id}`, { replace: true });
        return;
      }

      const failure = completionError ?? readbackError;
      setError(failure instanceof Error ? failure.message : 'ARIA could not complete this recording.');
      setState('error');
    })();
    finalizePromiseRef.current = task;
    return task;
  }, [cleanupResources, navigate]);

  async function handlePlaybackDisconnect(cause: Error) {
    // There is no safe resume point after transport loss: some PCM may have
    // reached transcription without an acknowledgement. Stop local playback
    // immediately rather than silently playing ahead or reconnecting with a
    // duplicate/gapped transcript.
    const player = playerRef.current;
    playerRef.current = null;
    if (player) await Promise.resolve(player.stop()).catch(() => {});
    transportRef.current?.close();
    transportRef.current = null;
    setError(cause.message);
    setState('error');
  }

  async function handleStart() {
    const validationError = validateRecordingFile(file);
    if (validationError) { setError(validationError); return; }
    if (!consent) { setError('Acknowledge that you have authority and permission to analyze this recording.'); return; }
    if (!duration || metadataLoading) { setError('Wait for ARIA to read the recording details, then retry.'); return; }

    setError(null);
    setSegments([]);
    setInterimText('');
    setCoaching(null);
    setProgress(0);
    userScrolledUpRef.current = false;
    setState('preparing');
    finalizePromiseRef.current = null;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current.playbackRate = PLAYBACK_RATE;
    }

    try {
      // Decode locally before creating a server meeting. In particular, this
      // rejects video-only or unsupported MP4s without sending source bytes.
      const player = new LocalRecordingPlayer();
      playerRef.current = player;
      await player.load(file!);

      const meeting = await createUploadedRecordingMeeting(player.durationSeconds);
      setMeetingId(meeting.id);
      meetingIdRef.current = meeting.id;
      const transport = new UploadedRecordingTransport(meeting.id, meeting.upload_ws_path);
      transportRef.current = transport;
      await transport.connect(applyLiveMessage, cause => { void handlePlaybackDisconnect(cause); });

      await transport.start({
        durationSeconds: player.durationSeconds,
      });
      await player.play({
        onPcm: pcm => transport.sendPcm(pcm),
        onProgress: seconds => setProgress(seconds),
        onEnded: () => { void finalize(); },
      });
      setState('playing');
    } catch (cause) {
      await cleanupResources(false);
      setError(cause instanceof Error ? cause.message : 'Could not start recording analysis.');
      setState('error');
    }
  }

  async function handlePauseResume() {
    try {
      if (state === 'playing') {
        await playerRef.current?.pause();
        transportRef.current?.pause();
        setState('paused');
      } else if (state === 'paused') {
        transportRef.current?.resume();
        await playerRef.current?.resume();
        setState('playing');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Playback control failed.');
    }
  }

  const canStart = !!file && duration > 0 && consent && !metadataLoading && !active;

  return (
    <div className="min-h-screen bg-gray-200 flex flex-col">
      <AppHeader title="Analyze a Recording" subtitle="Local playback with live ARIA coaching" backTo="/" />
      <main className="flex-1 px-4 py-4 pb-24 space-y-4 max-w-3xl w-full mx-auto">
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
          <div>
            <h1 className="font-semibold text-gray-900">Choose a recording</h1>
            <p className="text-sm text-gray-600 mt-1">
              Your source file stays on this device. ARIA never uploads or stores the source blob; only decoded mono 16-kHz audio is streamed during real-time playback.
            </p>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Local audio or MP4 file</span>
            <input
              aria-label="Local audio or MP4 file"
              type="file"
              accept={UPLOADED_RECORDING_ACCEPT}
              disabled={active}
              onChange={event => resetSelectedFile(event.target.files?.[0] ?? null)}
              className="mt-2 block w-full min-h-11 text-sm text-gray-700 file:min-h-11 file:mr-3 file:px-4 file:border-0 file:rounded-xl file:bg-blue-50 file:text-blue-700 file:font-semibold disabled:opacity-60"
            />
          </label>

          {objectUrl && file && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-3">
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                <div><dt className="text-gray-500">Filename</dt><dd className="font-medium text-gray-900 break-all">{file.name}</dd></div>
                <div><dt className="text-gray-500">Duration</dt><dd className="font-medium text-gray-900">{metadataLoading ? 'Reading…' : formatRecordingDuration(duration)}</dd></div>
                <div><dt className="text-gray-500">Type</dt><dd className="font-medium text-gray-900">{file.type || 'Unknown'}</dd></div>
              </dl>
              <audio
                ref={previewAudioRef}
                aria-label="Selected recording playback"
                controls={!active}
                controlsList="nodownload noplaybackrate"
                src={objectUrl}
                preload="metadata"
                onLoadedMetadata={event => {
                  const value = event.currentTarget.duration;
                  setDuration(Number.isFinite(value) ? value : 0);
                  setMetadataLoading(false);
                  if (!Number.isFinite(value) || value <= 0) setError('ARIA could not read this audio file. Choose another file and retry.');
                }}
                onError={() => {
                  setMetadataLoading(false);
                  setError(isMp4RecordingFile(file) ? recordingDecodeError(file).message : 'ARIA could not decode this audio file. Choose another file and retry.');
                }}
                onRateChange={event => { event.currentTarget.playbackRate = PLAYBACK_RATE; }}
                onSeeking={event => {
                  if (active) event.currentTarget.currentTime = progress;
                }}
                className="w-full"
              />
              {active && <p className="text-xs font-medium text-amber-700">Seeking and playback-speed changes are locked while analysis is active. Playback runs at 1x.</p>}
            </div>
          )}

          <label className="flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
            <input
              type="checkbox"
              checked={consent}
              disabled={active}
              onChange={event => { setConsent(event.target.checked); setError(null); }}
              className="mt-0.5 w-5 h-5 flex-none"
            />
            <span>I acknowledge that I have the authority and permission needed to use this recording for analysis.</span>
          </label>

          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error} {!active && <span className="font-semibold">You can correct it and retry.</span>}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              onClick={handleStart}
              disabled={!canStart}
              className="min-h-11 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-4"
            >
              {state === 'preparing' ? 'Starting…' : state === 'error' ? 'Retry Analysis' : '▶ Start Analysis'}
            </button>
            <button
              onClick={handlePauseResume}
              disabled={state !== 'playing' && state !== 'paused'}
              className="min-h-11 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-semibold px-4"
            >
              {state === 'paused' ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              onClick={() => { void finalize(); }}
              disabled={state !== 'playing' && state !== 'paused'}
              className="min-h-11 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700 font-semibold px-4"
            >
              ■ Stop
            </button>
          </div>

          {(active || state === 'complete') && (
            <div aria-live="polite" className="space-y-1">
              <div className="flex justify-between text-xs text-gray-600">
                <span>{state === 'paused' ? 'Paused' : state === 'stopping' ? 'Finalizing…' : state === 'complete' ? 'Complete' : 'Analyzing at 1x'}</span>
                <span>{formatRecordingDuration(progress)} / {formatRecordingDuration(duration)}</span>
              </div>
              <progress aria-label="Playback progress" max={duration || 1} value={Math.min(progress, duration || 1)} className="w-full h-2" />
            </div>
          )}
        </section>

        {(active || segments.length > 0 || coaching) && (
          <>
            <CoachingPanel coaching={coaching} />
            <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
              <h2 className="font-semibold text-gray-900 mb-3">Live transcript</h2>
              <div
                ref={transcriptContainerRef}
                onScroll={handleTranscriptScroll}
                aria-label="Live transcript"
                aria-live="polite"
                className="max-h-80 overflow-y-auto space-y-2"
              >
                {segments.length === 0 && !interimText && <p className="text-sm text-gray-500">Transcript will appear as the recording plays…</p>}
                {segments.map((segment, index) => (
                  <div key={segment.id ?? `${segment.ts}-${index}`} className="text-sm">
                    <span className="font-semibold text-blue-700">{segment.speaker || 'Speaker'}: </span>
                    <span className="text-gray-800">{segment.text}</span>
                  </div>
                ))}
                {interimText && <p className="text-sm text-gray-500 italic">{interimText}</p>}
              </div>
            </section>
          </>
        )}

        {state === 'complete' && meetingId && (
          <button onClick={() => navigate(`/meetings/${meetingId}`)} className="w-full min-h-11 rounded-xl bg-blue-600 text-white font-semibold">
            View completed meeting
          </button>
        )}
      </main>
    </div>
  );
}
