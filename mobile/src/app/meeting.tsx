/**
 * meeting.tsx — In-person meeting screen.
 *
 * What this DOES prove end-to-end:
 *   1. Requests microphone permission via expo-audio.
 *   2. Creates a meeting row via the EXISTING `POST /api/meetings` endpoint.
 *   3. Opens a WebSocket to the EXISTING `/meetings/:id/audio` endpoint —
 *      the exact same URL contract the web PWA uses (see
 *      app/web/src/pages/MeetingPage.tsx `getWsBase()` + `connectWebSocket()`).
 *   4. Shows a live connection-state badge (connecting/connected/error) once
 *      the WS handshake completes or fails.
 *   5. (2026-08-04) Streams real microphone audio to the backend as 16kHz
 *      mono linear16 PCM binary WS frames — see `src/lib/audioStream.ts` for
 *      the full design writeup and the iOS/Android platform split (iOS only
 *      for now; Android's expo-audio/MediaRecorder backend has no raw-PCM
 *      output option, see that file's header for why).
 *   6. Renders incoming `interim`/`final` transcript messages from the
 *      backend live, same message shape the web PWA already consumes.
 *
 * ⚠️ NOT verified against a real device from this sandbox — no physical
 * iOS device or Expo Go runtime is available here. The wire format (16kHz
 * linear16 PCM, raw binary WS frames) WAS verified end-to-end against the
 * live production backend using a synthetic PCM chunk sent through a real
 * `ws` WebSocket client — see memory/aria-mobile-audio-streaming-2026-08-04.md
 * for the full transcript of that test. What remains unverified: whether
 * `expo-audio`'s iOS `AVAudioRecorder`-backed chunked recording actually
 * behaves as expected in practice (timing, file I/O latency, WAV header
 * correctness for a real short recording) — that requires a real device.
 *
 * No reconnect/backoff logic yet (present in the web app, not ported here —
 * out of scope for this pass; flagged as a known gap, see report).
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { requestRecordingPermissionsAsync, useAudioRecorder } from 'expo-audio';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { createMeeting, getStoredSessionId, getWsBase, Meeting, updateMeeting } from '@/lib/api';
import {
  armRecordingSession,
  ChunkedPcmStreamer,
  getStreamingRecorderOptions,
  STREAMING_SUPPORTED_PLATFORM,
} from '@/lib/audioStream';

type Stage =
  | 'idle'
  | 'requesting-mic'
  | 'mic-denied'
  | 'creating-meeting'
  | 'connecting-ws'
  | 'connected'
  | 'ws-error'
  | 'ended';

type TranscriptSegment = {
  speaker: string;
  text: string;
  isFinal: boolean;
  key: string;
};

export default function MeetingScreen() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState<{ speaker: string; text: string } | null>(null);
  const [streamWarning, setStreamWarning] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamerRef = useRef<ChunkedPcmStreamer | null>(null);
  const segmentCounter = useRef(0);

  // expo-audio recorder instance for streaming (iOS only — see
  // audioStream.ts header for why). Options are stable so the hook doesn't
  // recreate the recorder on every render.
  const recorder = useAudioRecorder(getStreamingRecorderOptions());

  const cleanup = useCallback(() => {
    streamerRef.current?.stop().catch(() => {});
    streamerRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  async function handleStart() {
    setErrorMsg(null);
    setStreamWarning(null);
    setSegments([]);
    setInterim(null);

    // Step 1: mic permission
    setStage('requesting-mic');
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setStage('mic-denied');
        return;
      }
    } catch (err) {
      setStage('mic-denied');
      setErrorMsg(err instanceof Error ? err.message : 'Microphone permission request failed.');
      return;
    }

    // Step 1.5: arm the native recording session (expo-audio's recorder
    // refuses to actually record until `setAudioModeAsync({ allowsRecording:
    // true })` has been called at least once — see the "ROOT CAUSE FIX"
    // note in audioStream.ts's header for the full explanation). Fire this
    // off now, in parallel with meeting creation below, so it's already
    // done well before the WS opens and the user sees "listening" — rather
    // than only starting this async native call for the first time inside
    // the streamer's onopen handler, which left a real (previously
    // unaccounted-for) window where the app looked ready but the recorder
    // could not yet be told to record. iOS-only concern (no-op cost on
    // Android since streaming isn't supported there anyway, but calling it
    // is harmless either way).
    const armPromise = STREAMING_SUPPORTED_PLATFORM
      ? armRecordingSession().catch((err) => {
          console.log('[audio stream] failed to arm recording session early:', err);
        })
      : Promise.resolve();

    // Step 2: create meeting via existing backend contract (POST /api/meetings)
    setStage('creating-meeting');
    let created: Meeting;
    try {
      [created] = await Promise.all([createMeeting(), armPromise]);
      setMeeting(created);
    } catch (err) {
      setStage('ws-error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create meeting.');
      return;
    }

    // Step 3: open WebSocket — confirmed on a real device that RN's
    // WebSocket doesn't reliably carry the httpOnly session cookie the web
    // PWA relies on, so we append the session id (returned only to mobile
    // clients at login, see src/lib/api.ts) as a query param the backend
    // accepts as a fallback auth path (see authWebSocket() in server.js).
    setStage('connecting-ws');
    const sessionId = await getStoredSessionId();
    const wsBase = getWsBase();
    const wsUrl = `${wsBase}/meetings/${created.id}/audio${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`;
    console.log('[meeting ws] resolved wsBase =', wsBase, '| auth =', sessionId ? 'session-query-param' : 'cookie-only (no stored sessionId!)');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStage('connected');

      // Step 4: start streaming real mic audio once the socket is open.
      // iOS only for now (see audioStream.ts header) — on Android we still
      // reach "connected" (proving the WS/auth pipe works) but surface a
      // clear, non-fatal warning instead of silently sending nothing or
      // sending audio in the wrong format.
      if (!STREAMING_SUPPORTED_PLATFORM) {
        setStreamWarning(
          'Live audio streaming is iOS-only in this build — Android mic capture is not yet supported (see build notes).'
        );
        return;
      }
      const streamer = new ChunkedPcmStreamer(recorder, ws, {
        onError: (msg) => {
          console.log('[audio stream] error:', msg);
          setStreamWarning(msg);
        },
      });
      streamerRef.current = streamer;
      streamer.start().catch((err) => {
        setStreamWarning(err instanceof Error ? err.message : 'Failed to start audio streaming.');
      });
    };
    ws.onerror = (evt: unknown) => {
      // RN's native WebSocket Event carries no message on 'error' itself —
      // the real failure reason (if any) arrives on the subsequent 'close'
      // event as `code`/`reason` (see react-native/Libraries/WebSocket/WebSocket.js
      // websocketFailed handler). Log the raw event defensively in case a
      // future RN/Expo version does attach detail here.
      console.log('[meeting ws] onerror event:', evt);
      setStage('ws-error');
      // Set a fallback message only — onclose below unconditionally
      // overwrites it with the real code/reason once it fires.
      setErrorMsg(`WebSocket connection failed (base: ${wsBase}). Check network/backend URL.`);
    };
    ws.onclose = (evt: { code?: number; reason?: string }) => {
      console.log('[meeting ws] onclose code:', evt?.code, 'reason:', evt?.reason);
      streamerRef.current?.stop().catch(() => {});
      streamerRef.current = null;
      // Only treat as an error if we hadn't already ended intentionally.
      setStage((prev) => (prev === 'ended' ? prev : 'ws-error'));
      setErrorMsg(
        `Connection closed (code ${evt?.code ?? 'unknown'}${evt?.reason ? `: ${evt.reason}` : ''}). Base: ${wsBase}.`
      );
    };
    ws.onmessage = (evt) => {
      handleWsMessage(evt.data);
    };
  }

  function handleWsMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log('[meeting ws] non-JSON message:', raw);
      return;
    }

    if (msg.type === 'interim') {
      setInterim({ speaker: msg.speaker || 'Speaker', text: msg.text || '' });
    } else if (msg.type === 'final') {
      setInterim(null);
      if (msg.text && String(msg.text).trim()) {
        segmentCounter.current += 1;
        setSegments((prev) => [
          ...prev,
          {
            speaker: msg.speaker || 'Speaker',
            text: msg.text,
            isFinal: true,
            key: `seg-${segmentCounter.current}`,
          },
        ]);
      }
    } else if (msg.type === 'error') {
      console.log('[meeting ws] server error message:', msg.error);
    }
    // coaching/speaker_lock/speaker_merge/etc. messages are intentionally
    // not handled here yet — out of scope for this pass (live transcript
    // rendering only). See report for what remains.
  }

  async function handleEnd() {
    setStage('ended');
    cleanup();
    if (meeting) {
      try {
        await updateMeeting(meeting.id, { status: 'completed', ended_at: new Date().toISOString() });
      } catch {
        // non-fatal for this pass
      }
    }
  }

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ThemedView style={styles.container}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <ThemedText type="link">← Back</ThemedText>
          </Pressable>

          <ThemedText type="title" style={styles.title}>
            In-Person Meeting
          </ThemedText>

          <ThemedView style={styles.statusCard}>
            <StatusRow stage={stage} />
            {errorMsg && (
              <ThemedText type="small" style={styles.errorText}>
                {errorMsg}
              </ThemedText>
            )}
            {streamWarning && (
              <ThemedText type="small" style={styles.warningText}>
                ⚠️ {streamWarning}
              </ThemedText>
            )}
            {meeting && (
              <ThemedText type="small" themeColor="textSecondary">
                Meeting ID: {meeting.id}
              </ThemedText>
            )}
          </ThemedView>

          {(stage === 'connected' || segments.length > 0) && (
            <ThemedView style={styles.transcriptCard}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.transcriptLabel}>
                LIVE TRANSCRIPT
              </ThemedText>
              <ScrollView style={styles.transcriptScroll}>
                {segments.length === 0 && !interim && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Listening…
                  </ThemedText>
                )}
                {segments.map((seg) => (
                  <ThemedText key={seg.key} type="small" style={styles.transcriptLine}>
                    <ThemedText type="smallBold">{seg.speaker}: </ThemedText>
                    {seg.text}
                  </ThemedText>
                ))}
                {interim && (
                  <ThemedText type="small" style={[styles.transcriptLine, styles.interimText]}>
                    <ThemedText type="smallBold" style={styles.interimText}>
                      {interim.speaker}:{' '}
                    </ThemedText>
                    {interim.text}
                  </ThemedText>
                )}
              </ScrollView>
            </ThemedView>
          )}

          {stage === 'idle' || stage === 'mic-denied' || stage === 'ws-error' || stage === 'ended' ? (
            <Pressable onPress={handleStart} style={[styles.button, styles.startButton]}>
              <ThemedText style={styles.buttonText}>🎙️ Start Meeting</ThemedText>
            </Pressable>
          ) : stage === 'connected' ? (
            <Pressable onPress={handleEnd} style={[styles.button, styles.endButton]}>
              <ThemedText style={styles.buttonText}>⏹ End Meeting</ThemedText>
            </Pressable>
          ) : (
            <ThemedView style={styles.loadingRow}>
              <ActivityIndicator />
              <ThemedText type="small" themeColor="textSecondary">
                {stageLabel(stage)}
              </ThemedText>
            </ThemedView>
          )}

          {stage !== 'connected' && segments.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.stubNote}>
              {STREAMING_SUPPORTED_PLATFORM
                ? 'Live audio streaming (iOS) — not yet verified on a real device.'
                : 'Live audio streaming is iOS-only in this build.'}
            </ThemedText>
          )}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

function stageLabel(stage: Stage): string {
  switch (stage) {
    case 'requesting-mic':
      return 'Requesting microphone permission…';
    case 'creating-meeting':
      return 'Creating meeting…';
    case 'connecting-ws':
      return 'Connecting…';
    default:
      return '';
  }
}

function StatusRow({ stage }: { stage: Stage }) {
  const map: Record<Stage, { label: string; color: string }> = {
    idle: { label: 'Not started', color: '#9CA3AF' },
    'requesting-mic': { label: 'Requesting mic…', color: '#F59E0B' },
    'mic-denied': { label: 'Microphone permission denied', color: '#DC2626' },
    'creating-meeting': { label: 'Creating meeting…', color: '#F59E0B' },
    'connecting-ws': { label: 'Connecting…', color: '#F59E0B' },
    // NOTE: on platforms where streaming isn't supported (Android — see
    // audioStream.ts), this label is intentionally overridden below to a
    // non-green, explicitly-worded status instead of "listening", so a user
    // never mistakes "WS connected" for "mic is actually capturing audio".
    connected: { label: 'Connected — listening', color: '#16A34A' },
    'ws-error': { label: 'Connection error', color: '#DC2626' },
    ended: { label: 'Meeting ended', color: '#6B7280' },
  };
  let { label, color } = map[stage];
  if (stage === 'connected' && !STREAMING_SUPPORTED_PLATFORM) {
    label = 'Connected — mic NOT recording (unsupported on this device)';
    color = '#B45309';
  }
  return (
    <ThemedView style={styles.statusRow}>
      <ThemedView style={[styles.dot, { backgroundColor: color }]} />
      <ThemedText type="smallBold">{label}</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, padding: Spacing.four, gap: Spacing.four },
  backButton: { alignSelf: 'flex-start' },
  title: { fontSize: 28, lineHeight: 34 },
  statusCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 10, height: 10, borderRadius: 5 },
  errorText: { color: '#DC2626' },
  warningText: { color: '#B45309' },
  transcriptCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    flex: 1,
    minHeight: 120,
    maxHeight: 320,
  },
  transcriptLabel: { marginBottom: Spacing.two, letterSpacing: 0.5 },
  transcriptScroll: { flexGrow: 0 },
  transcriptLine: { marginBottom: Spacing.two },
  interimText: { color: '#9CA3AF', fontStyle: 'italic' },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButton: { backgroundColor: '#16A34A' },
  endButton: { backgroundColor: '#DC2626' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  loadingRow: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center', justifyContent: 'center' },
  stubNote: { textAlign: 'center', marginTop: 'auto' },
});
