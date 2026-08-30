import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inRecordingPath, postRecordingPath } from '../lib/meetingRoutes';
import CoachingPanel, { CoachingData } from '../components/CoachingPanel';
import { EndMeetingButton, EndMeetingConfirmModal } from '../components/EndMeetingButton';
import {
  createUploadedRecordingMeeting,
  Customer,
  getCustomer,
  getMeeting,
  getMeetingSegments,
  TranscriptSegment,
  updateMeeting,
} from '../lib/api';
import CustomerInfoSection from '../components/CustomerInfoSection';
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

export default function UploadedRecordingPage({ onMeetingStarted }: { onMeetingStarted?: (meetingId: string) => void } = {}) {
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
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [meetingId, setMeetingId] = useState<string | null>(null);
  // 2026-08-29 (aria_customer_info_editable_section): mirrors MeetingPage's
  // own customerId/customer state so the shared CustomerInfoSection can
  // render here too. No caller of createUploadedRecordingMeeting() on this
  // page currently passes a customer_id (verified live — handleStart()
  // below calls it with only durationSeconds; there is no customer-
  // selection step anywhere in this page's upload/analyze flow), so
  // customerId is always null/undefined in practice today and the section
  // renders its graceful "No customer linked" empty state — but the wiring
  // is real (not stubbed) so it activates automatically if a future pass
  // adds a customer-selection step to this flow, exactly like MeetingPage.
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  // End Meeting confirmation state (parity with MeetingPage.tsx's in-person
  // End Meeting flow — see handleEndMeetingButtonClick() below).
  const [showEndMeetingConfirm, setShowEndMeetingConfirm] = useState(false);
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

  // 2026-08-29 (aria_customer_info_editable_section): mirrors MeetingPage's
  // own customer-fetch effect — loads the linked customer's editable detail
  // once customerId is known. See customerId's own comment above for why
  // this is currently a no-op on this page (no caller of
  // createUploadedRecordingMeeting() passes a customer_id yet) but wired
  // for real rather than stubbed.
  useEffect(() => {
    if (!customerId) {
      setCustomer(null);
      return;
    }
    let cancelled = false;
    getCustomer(customerId)
      .then(c => { if (!cancelled) setCustomer(c); })
      .catch(() => { if (!cancelled) setCustomer(null); });
    return () => { cancelled = true; };
  }, [customerId]);

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
    setSpeakerLabels({});
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
    } else if (msg.type === 'speaker_repair') {
      const corrections = Array.isArray(msg.corrections) ? msg.corrections : [];
      const byId = new Map<string, string>(corrections
        .filter((item: any) => typeof item?.id === 'string' && typeof item?.speaker === 'string')
        .map((item: any): [string, string] => [String(item.id), String(item.speaker)]));
      if (byId.size > 0) {
        setSegments(previous => previous.map(segment => {
          const repaired = segment.id ? byId.get(segment.id) : undefined;
          return repaired ? { ...segment, speaker: repaired } : segment;
        }));
      }
      if (msg.speakerLabels && typeof msg.speakerLabels === 'object') {
        setSpeakerLabels(msg.speakerLabels as Record<string, string>);
      }
    } else if (msg.type === 'speaker_lock') {
      const speakerId = typeof msg.speakerId === 'string' ? msg.speakerId : '';
      const name = typeof msg.name === 'string' ? msg.name.trim() : '';
      if (speakerId && name) setSpeakerLabels(previous => ({ ...previous, [speakerId]: name }));
    } else if (msg.type === 'speaker_merge') {
      const from = typeof msg.from === 'string' ? msg.from : '';
      const to = typeof msg.to === 'string' ? msg.to : '';
      if (from && to) setSegments(previous => previous.map(segment => (
        segment.speaker === from ? { ...segment, speaker: to } : segment
      )));
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
        navigate(postRecordingPath(id), { replace: true });
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
        navigate(postRecordingPath(id), { replace: true });
        return;
      }

      const failure = completionError ?? readbackError;
      setError(failure instanceof Error ? failure.message : 'ARIA could not complete this recording.');
      setState('error');
    })();
    finalizePromiseRef.current = task;
    return task;
  }, [navigate]);

  // Entry point for the bottom "End Meeting" button (the renamed/restyled
  // former "Stop Analysis" control) — parity with MeetingPage.tsx's
  // handleEndMeetingButtonClick() for the states where there is genuinely
  // live playback/analysis in flight.
  //
  // 2026-08-30 (aria_uploaded_recording_end_always_active): Troy's ask —
  // reps landing on this page in 'idle' (nothing selected/started yet),
  // 'preparing' (starting up), 'error' (a prior attempt failed), or
  // 'complete' (analysis already finished — a separate "View completed
  // meeting analysis" button covers that case) had NO way to get back to
  // the homepage, because the button below was `disabled` in exactly those
  // states. There is nothing destructive to confirm in any of those states
  // (no live recording/streaming is in flight), so clicking End Meeting
  // here just navigates straight home — no confirm dialog. Only while
  // 'playing' or 'paused' does this open the confirm dialog and, on
  // Confirm, call the exact same finalize() as before — that path is
  // UNCHANGED from prior behavior.
  function handleEndMeetingButtonClick() {
    if (state === 'playing' || state === 'paused') {
      setShowEndMeetingConfirm(true);
      return;
    }
    navigate('/');
  }

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
      setCustomerId(meeting.customer_id ?? null);
      if (onMeetingStarted) {
        onMeetingStarted(meeting.id);
        navigate(inRecordingPath(meeting.id), { replace: true });
      }
      setSpeakerLabels(meeting.speaker_labels || {});
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
  const uniqueSpeakers = Array.from(new Set(segments.map(segment => segment.speaker).filter(Boolean)));

  function getDisplayLabel(rawSpeaker: string): string {
    return speakerLabels[rawSpeaker] || rawSpeaker;
  }

  function handleSpeakerLabelChange(rawSpeaker: string, label: string) {
    const next = { ...speakerLabels, [rawSpeaker]: label };
    setSpeakerLabels(next);
    const id = meetingIdRef.current;
    if (id) updateMeeting(id, { speaker_labels: next }).catch(() => {});
  }

  return (
    <div className="active-meeting-page bg-gray-200 flex flex-col">
      {/* 2026-08-29 (aria_active_meeting_banner_info_left_panel): this page
          is ALWAYS the active/three-column layout (there is no non-active
          render branch here — completion navigates away to the post-
          recording route, which is MeetingPage's own AppHeader-bearing
          view), so AppHeader is never mounted at all now; no top-of-page
          banner strip is rendered here. The equivalent title now renders
          at the very top of the left/"type" column below instead — see
          data-meeting-status-location="left-column". */}
      <main data-active-meeting-layout="three-column" className="uploaded-active-meeting-workspace">
        <section data-meeting-column="feedback" aria-label="ARIA Feedback" className="uploaded-feedback-column">
          <div data-aria-feedback-panel className="w-full h-full flex flex-col">
            <CoachingPanel coaching={coaching} />
          </div>
        </section>
        <section data-meeting-column="transcript" aria-label="Speaker and transcript controls" className="uploaded-right-column">
          <section data-speaker-controls aria-label="Rename Speakers" className="uploaded-speaker-column bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Rename Speakers</h2>
          {uniqueSpeakers.length > 0 ? (
            <div className="space-y-2">
              {uniqueSpeakers.map(speaker => (
                <div key={speaker} className="flex items-center gap-2">
                  <span className="text-sm text-gray-500 w-24 flex-shrink-0">{speaker}</span>
                  <input
                    aria-label={`Rename ${speaker}`}
                    type="text"
                    placeholder={`Rename ${speaker}`}
                    value={speakerLabels[speaker] || ''}
                    onChange={event => handleSpeakerLabelChange(speaker, event.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">Speaker names appear here as the transcript grows.</p>
          )}
          </section>

          <section data-live-transcript aria-label="Transcript" className="uploaded-transcript-column bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
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
                    <span className="font-semibold text-blue-700">{getDisplayLabel(segment.speaker || 'Speaker')}: </span>
                    <span className="text-gray-800">{segment.text}</span>
                  </div>
                ))}
                {interimText && <p className="text-sm text-gray-500 italic">{interimText}</p>}
              </div>
          </section>
        </section>

        <section data-meeting-column="type" aria-label="Playback and analysis controls" className="uploaded-type-column bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
          {/* 2026-08-29 (aria_active_meeting_banner_info_left_panel): the
              title/status truth that used to live in the page-top AppHeader
              banner (now not rendered at all on this page — see above) now
              renders here instead, at the very top of this left/"type"
              column, above the existing upload/playback content and above
              the bottom-anchored End Meeting control. This page has no
              recording/synced/completed branch of its own (that lives on
              MeetingPage.tsx after this page navigates away on completion),
              so the status line is always "Active" while mounted, with no
              connection badge (there is no live audio-pipeline WebSocket
              connection state comparable to MeetingPage.tsx's owner/observer
              sockets for this local-file-playback flow).

              2026-08-30 (aria_uploaded_recording_simplify_copy): per Gabe's
              explicit ask, this page's title row no longer carries the
              "Uploaded Recording" type label added by
              aria_left_panel_title_type_duration, and row 2 is simplified
              from "Active · local playback with live ARIA coaching" down to
              just "Active". This is a copy simplification for THIS PAGE
              ONLY — MeetingPage.tsx's equivalent type labels are unchanged
              and out of scope. */}
          <div
            data-meeting-status-location="left-column"
            className="flex-none rounded-2xl px-4 py-3 bg-green-700 text-white"
          >
            <div className="flex items-baseline gap-2 min-w-0">
              <p className="text-lg font-bold leading-tight truncate min-w-0">Analyze a Recording</p>
            </div>
            <p className="text-white/80 text-sm leading-snug truncate">Active</p>
          </div>

          {/* 2026-08-29 (aria_customer_info_editable_section): renders
              directly under the title+type row / duration row block above,
              shared with MeetingPage.tsx via CustomerInfoSection so all
              three meeting types get the identical editable section — see
              customerId's own comment above for why this always renders the
              graceful "No customer linked" empty state on this page today. */}
          <CustomerInfoSection
            customerId={customerId}
            name={customer?.name}
            address={customer?.address}
            phone={customer?.phone}
            email={customer?.email}
            onSaved={updatedCustomer => setCustomer(updatedCustomer)}
          />

          {/* 2026-08-29 (aria_uploaded_recording_hide_selector_after_pick):
              once analysis is active (a recording has been selected AND
              "Start Analysis" has run — see the `active` state derivation
              above), the entire "Choose a recording" section (heading,
              privacy copy, and file input) is unmounted rather than merely
              disabled. This page never navigates away on its own while
              active (completion navigates to the post-recording route,
              which is a different page/component), so this section reliably
              reappears on any fresh mount or full reset where `active` is
              false and a new file can be chosen. */}
          {!active && (
            <div role="group" aria-labelledby="recording-selection-heading" className="space-y-4">
              <div>
                <h1 id="recording-selection-heading" className="font-semibold text-gray-900">Choose a recording</h1>
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
            </div>
          )}

          {/* 2026-08-30 (aria_uploaded_recording_hide_metadata_during_analysis):
              the pre-analysis file-selection chrome below (heading,
              Filename/Duration/Type metadata, the preview <audio> element +
              its locked-seeking note, and the consent checkbox) only serves
              a purpose while a file is being selected/reviewed. Once
              analysis is active it is unmounted entirely — it reliably
              reappears whenever `active` is false again (idle for a fresh
              pick, or complete/error, matching this page's existing
              idle-only "Choose a recording" section above). The preview
              <audio> element here is NOT load-bearing for playback/PCM
              streaming: actual analysis-time playback and PCM chunking are
              driven entirely by LocalRecordingPlayer's own AudioContext /
              AudioBufferSourceNode / ScriptProcessorNode (see handleStart()
              above and lib/uploadedRecording.ts), which is fully independent
              of this DOM node. previewAudioRef is only touched synchronously
              in handleStart() (pause/reset) before this section unmounts, so
              full removal here is safe. */}
          {!active && (
            <>
              <h2 className="font-semibold text-gray-900">Playback &amp; analysis controls</h2>

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
            </>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error} {!active && <span className="font-semibold">You can correct it and retry.</span>}
            </div>
          )}

          {(active || state === 'complete') && (
            <div aria-live="polite" className="space-y-1">
              <div className="flex justify-between text-xs text-gray-600">
                <span>{state === 'paused' ? 'Paused' : state === 'stopping' ? 'Finalizing…' : state === 'complete' ? 'Complete' : 'Analyzing at 1x'}</span>
                <span>{formatRecordingDuration(progress)} / {formatRecordingDuration(duration)}</span>
              </div>
              <progress aria-label="Playback progress" max={duration || 1} value={Math.min(progress, duration || 1)} className="w-full h-2" />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
          </div>

          {state === 'complete' && meetingId && (
            <button
              onClick={() => navigate(postRecordingPath(meetingId))}
              className="w-full min-h-11 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-4"
            >
              View completed meeting analysis
            </button>
          )}

          {/* "End Meeting" replaces the former "■ Stop Analysis" control. Same
              label/icon, placement (bottom of this left/type column, pinned
              via .active-meeting-end-control's margin-top: auto — the exact
              mechanism MeetingPage.tsx's in-person End Meeting button uses),
              and styling as the in-person page (see EndMeetingButton/
              EndMeetingConfirmModal in ../components/EndMeetingButton,
              extracted from MeetingPage.tsx for guaranteed parity).

              2026-08-30 (aria_uploaded_recording_end_always_active): only
              disabled during 'stopping' — a finalize() is already in flight
              at that point (async round-trip to acknowledge/persist
              completion), and a second click mid-finalize has no well-
              defined action, so it's momentarily disabled rather than firing
              a redundant finalize or an ambiguous home-nav while that
              settles. Every OTHER state ('idle', 'preparing', 'playing',
              'paused', 'error', 'complete') now leaves this always
              clickable — Troy's ask was that this button always be a
              working escape hatch back to home. See
              handleEndMeetingButtonClick() above for the per-state
              behavior: playing/paused still opens the confirm dialog and
              Confirm still calls the same finalize() as before (unchanged);
              every other reachable state navigates straight home since
              there's nothing live to confirm ending. */}
          <div data-meeting-end-control className="active-meeting-end-control">
            <EndMeetingButton
              onClick={handleEndMeetingButtonClick}
              disabled={state === 'stopping'}
            />
          </div>
        </section>
      </main>

      {showEndMeetingConfirm && (
        <EndMeetingConfirmModal
          onConfirm={() => {
            setShowEndMeetingConfirm(false);
            void finalize();
          }}
          onCancel={() => setShowEndMeetingConfirm(false)}
        />
      )}
    </div>
  );
}
