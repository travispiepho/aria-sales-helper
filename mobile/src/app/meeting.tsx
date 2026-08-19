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
 * (2026-08-10) WS auto-reconnect with exponential backoff — ported from the
 * web PWA's `connectWebSocket()`/`ws.onclose` pattern in
 * app/web/src/pages/MeetingPage.tsx (same delay formula: 1000ms *
 * 2^attempts, capped at 10000ms, reset to 0 on a successful `onopen`).
 * Previously this screen had NO reconnect logic at all — any transient
 * disconnect (the 8/9 outage's 502s/dial-timeouts being the motivating
 * case) went straight to the 'ws-error' terminal stage with no retry,
 * unlike web. Only retries while still actively recording and not an
 * intentional user-initiated close (`endedIntentionallyRef`); gives up and
 * shows the existing 'ws-error' UI once `MAX_RECONNECT_ATTEMPTS` is
 * exceeded, matching the circuit-breaker-style ceiling added server-side
 * for the analogous Deepgram reconnect loop this same night.
 *
 * ── (2026-08-05) Leave-app-while-recording guard ───────────────────────────
 * Unlike the web PWA (which holds a Screen Wake Lock — see
 * app/web/src/pages/MeetingPage.tsx's `acquireWakeLock()` — so the browser
 * tab itself can't be screen-locked away mid-recording), the mobile chunked
 * recorder (`audioStream.ts`) has no equivalent: `expo-audio`'s
 * `AudioRecorder` is explicitly configured `shouldPlayInBackground: false`
 * (see `armRecordingSession()`), so iOS/Android WILL suspend/throttle mic
 * capture the moment the app backgrounds (screen lock, app switch, incoming
 * call, etc.) — the in-flight chunk is simply lost and no more chunks can
 * be recorded until the app is foregrounded again, silently truncating the
 * transcript with no user-visible signal. Two mitigations added here:
 *   1. A warning banner. (2026-08-05 update, later same day: originally
 *      this rendered for the ENTIRE recording duration — per feedback that
 *      was too much persistent on-screen noise for the whole meeting, so it
 *      now fires ONCE, right as recording starts (`ws.onopen`, the same
 *      moment `stage` becomes `'connected'`), stays visible for
 *      `LEAVE_WARNING_VISIBLE_MS` (4s — long enough to read a short
 *      sentence, short enough to not linger), then auto-dismisses via a
 *      timeout and does not reappear for the rest of that meeting. This is
 *      PURELY a display-duration change to mitigation 1 — mitigation 2
 *      below (the actual detection/auto-stop behavior) is untouched.)
 *   2. An `AppState` listener that detects the app leaving the foreground
 *      while recording is active and auto-stops client-side + finalizes the
 *      meeting server-side via the SAME `handleEnd()` path the manual
 *      "End Meeting" button uses (`PATCH /api/meetings/:id` with
 *      `status: 'completed'`) — no second finalize code path.
 *
 * Platform reliability notes (see report for full detail):
 *   - iOS: `AppState` reliably fires `background` when the app is put in
 *     the background (home/app-switch/screen lock) and `inactive` for
 *     transient interruptions (control center, incoming call banner,
 *     system alert) that do NOT necessarily mean the user "left". This
 *     listener only auto-stops on a transition INTO `background` (not
 *     `inactive`), to avoid false-positive stops on brief system overlays.
 *     Reliable in practice on iOS.
 *   - Android: `AppState` also fires `background` on home/recents/app-
 *     switch and screen lock, but Android's task-lifecycle model has more
 *     edge cases (e.g. some OEM "recent apps" previews, split-screen/
 *     picture-in-picture, or certain permission dialogs) where the event
 *     ordering/timing relative to actual process suspension is less
 *     consistent than iOS. Streaming itself is also iOS-only right now
 *     (see audioStream.ts header) so this is a lower-stakes gap on Android
 *     today, but the detection logic itself is NOT guaranteed airtight on
 *     every Android OEM skin — flagged as a known limitation, not silently
 *     assumed reliable.
 *   - Neither platform can guarantee the JS AppState callback finishes
 *     firing our async `handleEnd()` (which does a network PATCH) before
 *     the OS fully suspends the process — there's no way to make this 100%
 *     reliable purely from JS/Expo without a native background task
 *     (e.g. `expo-background-task`) to extend execution time. In practice
 *     `PATCH /api/meetings/:id` is small and fast and RN/iOS grant a short
 *     background execution grace window after backgrounding, so this
 *     should usually complete — but it is not provably guaranteed, and the
 *     Objective 2 server-side fix (WS `close` handler finalizing the
 *     meeting even if this client-side PATCH never lands) is the actual
 *     safety net for this.
 */

import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { requestRecordingPermissionsAsync, useAudioRecorder } from 'expo-audio';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { createMeeting, getStoredSessionId, getWsBase, Meeting, MeetingChannel, updateMeeting } from '@/lib/api';
import { createReconnectTracker, ReconnectTracker } from '@/lib/reconnectPolicy';
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
  // (2026-08-10) distinct from 'ws-error': a transient disconnect that is
  // actively being retried via exponential backoff (see file header +
  // connectWebSocket() below), matching web's separate 'reconnecting'
  // connectionStatus in app/web/src/pages/MeetingPage.tsx. 'ws-error' is now
  // reserved for the terminal case — initial connect failure, or giving up
  // after MAX_RECONNECT_ATTEMPTS.
  | 'reconnecting'
  | 'ws-error'
  | 'ended';

type TranscriptSegment = {
  speaker: string;
  text: string;
  isFinal: boolean;
  key: string;
  // 2026-08-18 (Deepgram reconnect hardening, mobile equivalent of the web
  // PWA's TranscriptSegment.kind) — set for an inline lapse/recovery/
  // terminal-stop system notice instead of a normal speaker line. See
  // web/src/pages/MeetingPage.tsx's TranscriptLapseNotice for the shared
  // rationale/copy this mirrors.
  kind?: 'lapse-start' | 'lapse-end' | 'lapse-stopped';
  lapseDurationMs?: number;
};

export default function MeetingScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  // (2026-08-10) Meeting channel chosen on the new pre-recording
  // meeting-setup.tsx step, passed through as a route param and forwarded
  // to createMeeting() below so the EXISTING `meetings.channel` column
  // (see api.ts's Meeting.channel doc) is set from the user's real choice
  // instead of always falling through to its 'in_person' DB default.
  // Defensive fallback to 'in_person' covers the pre-existing fallback
  // route into this screen (see (tabs)/record.tsx's Redirect) that never
  // goes through meeting-setup.tsx and so never supplies this param.
  const { channel: channelParam } = useLocalSearchParams<{ channel?: string }>();
  const meetingChannel: MeetingChannel = channelParam === 'phone' ? 'phone' : 'in_person';
  const [stage, setStage] = useState<Stage>('idle');
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState<{ speaker: string; text: string } | null>(null);
  const [streamWarning, setStreamWarning] = useState<string | null>(null);
  // (2026-08-05, later same day) One-time leave-app warning visibility —
  // see file header "Leave-app-while-recording guard" section. Flips true
  // the instant recording starts (ws.onopen) and false again after
  // LEAVE_WARNING_VISIBLE_MS via a timeout — it is NOT tied to `stage` any
  // more, so it does not come back for the rest of the meeting even though
  // `stage` stays 'connected' the whole time.
  const [showLeaveWarning, setShowLeaveWarning] = useState(false);
  const leaveWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamerRef = useRef<ChunkedPcmStreamer | null>(null);
  const segmentCounter = useRef(0);
  // (2026-08-10) WS auto-reconnect — mirrors app/web/src/pages/MeetingPage.tsx's
  // reconnectAttemptsRef/reconnectTimerRef exactly (see file header). Reset
  // to 0 on a successful `onopen`; incremented on every reconnect attempt;
  // capped at MAX_RECONNECT_ATTEMPTS before giving up.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);
  const wsUrlRef = useRef<string | null>(null);
  // True once the WS has reached 'connected' at least once for the current
  // meeting — used only to gate the one-time leave-app warning below so a
  // mid-meeting reconnect doesn't re-show it.
  const hasConnectedOnceRef = useRef(false);
  // ── Smart auto-scroll (mirrors app/web/src/pages/MeetingPage.tsx's
  // `userScrolledUpRef` + `handleTranscriptScroll()` pattern exactly): the
  // transcript ScrollView auto-scrolls to the bottom as new lines/interim
  // text arrive UNLESS the user has manually scrolled away from the
  // bottom (e.g. to re-read an earlier line) — in which case auto-scroll
  // pauses so it doesn't fight the user, and resumes once they scroll back
  // down near the bottom themselves, or once a new meeting is started.
  const transcriptScrollRef = useRef<ScrollView | null>(null);
  const userScrolledUpRef = useRef(false);
  // Web uses a fixed 80px "distance from bottom" threshold on the DOM
  // scroll container to decide whether the user has intentionally scrolled
  // away from the live edge. RN's onScroll payload gives the same three
  // numbers (contentOffset.y, contentSize.height, layoutMeasurement.height)
  // so the same threshold translates directly.
  const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
  // How long the one-time "don't leave the app" warning stays on screen
  // after recording starts before auto-dismissing. 4s: long enough to read
  // the ~15-word sentence once, short enough to not linger and compete with
  // the transcript/status UI for the rest of the meeting.
  const LEAVE_WARNING_VISIBLE_MS = 4000;
  // (2026-08-10) WS reconnect tuning — same delay formula/cap as web's
  // connectWebSocket() (see file header): 1000ms * 2^attempts, capped at
  // 10000ms. MAX_RECONNECT_ATTEMPTS is a ceiling web doesn't have (web just
  // retries forever while isRecordingRef is true) — added here as a small,
  // additional safety net so a genuinely dead backend doesn't leave this
  // screen retrying indefinitely in the background; 8 attempts at the
  // capped 10s delay is a few minutes of retry coverage, comfortably
  // longer than the ~35min 8/9 outage window's individual gap durations.
  // 2026-08-18 hardening: superseded by the shared jittered-backoff +
  // ~60s-budget tracker (see @/lib/reconnectPolicy.ts) — kept only as
  // historical context for the comment above; the tracker owns these
  // numbers now (250ms→8s jittered, ~60s budget, ~14-attempt seatbelt).
  const reconnectTrackerRef = useRef<ReconnectTracker | null>(null);
  const dgLapseActiveRef = useRef(false);
  const dgLapseTerminalRef = useRef(false);
  const dgLapseStartedAtRef = useRef<number | null>(null);
  // Set synchronously by handleEnd() BEFORE ws.close() is called, so that by
  // the time the resulting onclose event fires, we can distinguish an
  // intentional user-initiated close (WS close code 1000, expected/normal)
  // from a genuine unexpected disconnect (network drop, auth rejection
  // codes like 4001/4003/4004, backend crash, etc.).
  const endedIntentionallyRef = useRef(false);

  // expo-audio recorder instance for streaming (iOS only — see
  // audioStream.ts header for why). Options are stable so the hook doesn't
  // recreate the recorder on every render.
  const recorder = useAudioRecorder(getStreamingRecorderOptions());

  const cleanup = useCallback(() => {
    isRecordingRef.current = false;
    streamerRef.current?.stop().catch(() => {});
    streamerRef.current = null;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    if (leaveWarningTimerRef.current) {
      clearTimeout(leaveWarningTimerRef.current);
      leaveWarningTimerRef.current = null;
    }
    // Intentional stop (End Meeting / unmount), not a failure — dispose
    // quietly so no stray lapse/give-up notice fires after the fact.
    reconnectTrackerRef.current?.dispose();
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // Always-current reference to handleEnd's latest closure (captures the
  // current `meeting` state) so the mount-once AppState listener below
  // never calls a stale version. `handleEnd` is a hoisted function
  // declaration further down in this component — assigning it here on
  // every render (not inside a useEffect) is intentional: it's a pure ref
  // write with no rendering side effects, and it must be up to date the
  // instant a background transition can fire, not one effect-cycle later.
  const handleEndRef = useRef<() => Promise<void>>(async () => {});
  handleEndRef.current = handleEnd;

  // Track the current stage in a ref for the same reason — the AppState
  // listener is subscribed once on mount and must always check the LATEST
  // stage, not the one from whatever render happened to be active when the
  // listener was attached.
  const stageRef = useRef<Stage>(stage);
  stageRef.current = stage;

  // ── Leave-app-while-recording guard (2026-08-05) ──────────────────────
  // See file header "Leave-app-while-recording guard" section for the full
  // iOS/Android reliability writeup. Only auto-stops on a transition INTO
  // 'background' (home button, app switcher, screen lock, task-kill) — NOT
  // on 'inactive', which on iOS also covers brief, non-departing system
  // overlays (control center, incoming call banner) that should not kill an
  // in-progress recording.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'background' && stageRef.current === 'connected') {
        console.log('[meeting] App backgrounded while recording was active — auto-stopping and finalizing meeting.');
        handleEndRef.current().catch((err) => {
          console.log('[meeting] auto-stop on backgrounding failed:', err);
        });
      }
    });
    return () => subscription.remove();
  }, []);

  // ── Back-navigation lockout while actively recording (2026-08-05) ─────
  // The on-screen ← Back button is conditionally rendered below (hidden
  // while `stage === 'connected'`), but that alone doesn't stop Android's
  // hardware/gesture back action, which React Navigation's native-stack
  // wires directly into a `goBack`-style action independent of whatever JSX
  // this component renders. `beforeRemove` is the standard React Navigation
  // event that fires for ANY action that would remove this screen from the
  // stack — hardware back button, edge-swipe-back gesture, and header back
  // button alike — so gating it on the same `stageRef` used above covers
  // all three in one place instead of only the on-screen button. Checked via
  // `stageRef` (not `stage`) so this listener — subscribed once — always
  // sees the current stage, same pattern as the AppState listener above.
  // Guarded on 'connected' only: this deliberately does NOT block leaving
  // once the meeting has ended ('ended') or during any pre-recording setup
  // stage, and it never blocks our OWN `handleEnd`-driven navigation since
  // the on-screen back button (the only in-component navigation call) is
  // hidden for the entire 'connected' stage, so this listener is never
  // fighting a navigation this component itself initiated.
  useEffect(() => {
    const subscription = navigation.addListener('beforeRemove', (e) => {
      if (stageRef.current === 'connected') {
        e.preventDefault();
      }
    });
    return subscription;
  }, [navigation]);

  async function handleStart() {
    endedIntentionallyRef.current = false;
    hasConnectedOnceRef.current = false;
    setErrorMsg(null);
    setStreamWarning(null);
    setSegments([]);
    setInterim(null);
    setShowLeaveWarning(false);
    if (leaveWarningTimerRef.current) {
      clearTimeout(leaveWarningTimerRef.current);
      leaveWarningTimerRef.current = null;
    }
    userScrolledUpRef.current = false; // fresh meeting starts pinned to the (empty) bottom

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
      [created] = await Promise.all([createMeeting(undefined, meetingChannel), armPromise]);
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
    isRecordingRef.current = true;
    reconnectAttemptsRef.current = 0;
    connectWebSocket(wsUrl);
  }

  // (2026-08-10) Opens (or re-opens, on reconnect) the audio WS. Ported from
  // app/web/src/pages/MeetingPage.tsx's `connectWebSocket()` — see file
  // header. Called once from handleStart() above, and again by itself (via
  // the reconnect timer in `ws.onclose` below) on every retry, reusing the
  // SAME wsUrl (same meeting id, same session-id query param) — this only
  // re-establishes the transport, it never re-creates the meeting or
  // re-requests mic permission.
  // 2026-08-18 (Deepgram reconnect hardening) — pushes an inline transcript
  // notice for a lapse-start/lapse-end/terminal-stop, deduped exactly like
  // web/src/pages/MeetingPage.tsx's pushLapseStartNotice/pushLapseEndNotice/
  // pushLapseStoppedNotice (same refs, same guard logic) so a rep sees one
  // notice per real lapse regardless of detection path. This screen only
  // has CLIENT-side detection (no server-pushed transcription_lapse handler
  // yet for the in-person WS route in this pass — see report), which is
  // still a real, independent detection path per the task's dedup design.
  function pushLapseStartNotice(startedAtMs?: number) {
    if (dgLapseActiveRef.current || dgLapseTerminalRef.current) return;
    dgLapseActiveRef.current = true;
    dgLapseStartedAtRef.current = startedAtMs ?? Date.now();
    segmentCounter.current += 1;
    setSegments((prev) => [...prev, { speaker: '', text: '', isFinal: true, key: `lapse-${segmentCounter.current}`, kind: 'lapse-start' }]);
  }

  function pushLapseEndNotice(durationMs?: number) {
    if (!dgLapseActiveRef.current) return;
    dgLapseActiveRef.current = false;
    const observedDuration = durationMs ?? (dgLapseStartedAtRef.current ? Date.now() - dgLapseStartedAtRef.current : undefined);
    dgLapseStartedAtRef.current = null;
    segmentCounter.current += 1;
    setSegments((prev) => [...prev, { speaker: '', text: '', isFinal: true, key: `lapse-${segmentCounter.current}`, kind: 'lapse-end', lapseDurationMs: observedDuration }]);
  }

  function pushLapseStoppedNotice() {
    if (dgLapseTerminalRef.current) return;
    dgLapseTerminalRef.current = true;
    dgLapseActiveRef.current = false;
    dgLapseStartedAtRef.current = null;
    segmentCounter.current += 1;
    setSegments((prev) => [...prev, { speaker: '', text: '', isFinal: true, key: `lapse-${segmentCounter.current}`, kind: 'lapse-stopped' }]);
  }

  function connectWebSocket(wsUrl: string) {
    const wsBase = getWsBase();
    wsUrlRef.current = wsUrl;
    setStage(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting-ws');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    if (!reconnectTrackerRef.current) {
      reconnectTrackerRef.current = createReconnectTracker({
        onLapseStart: (startedAtMs) => pushLapseStartNotice(startedAtMs),
        onLapseEnd: (durationMs) => pushLapseEndNotice(durationMs),
        onGiveUp: () => pushLapseStoppedNotice(),
      });
    }
    const tracker = reconnectTrackerRef.current;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      tracker.onConnected();
      setStage('connected');
      setErrorMsg(null);

      // One-time leave-app warning (see file header): fire right as
      // recording actually starts, auto-dismiss after
      // LEAVE_WARNING_VISIBLE_MS, and never show it again for the rest of
      // this meeting (does not re-trigger on later renders since it's not
      // gated on `stage` any more). Only on the FIRST connect — a
      // reconnect mid-meeting shouldn't re-show this.
      if (!hasConnectedOnceRef.current) {
        hasConnectedOnceRef.current = true;
        setShowLeaveWarning(true);
        if (leaveWarningTimerRef.current) clearTimeout(leaveWarningTimerRef.current);
        leaveWarningTimerRef.current = setTimeout(() => {
          setShowLeaveWarning(false);
          leaveWarningTimerRef.current = null;
        }, LEAVE_WARNING_VISIBLE_MS);
      }

      // Step 4: (re)start streaming real mic audio once the socket is open.
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
      // future RN/Expo version does attach detail here. The actual
      // stage/reconnect decision is made in onclose below, not here — same
      // split web uses (onerror just flips a status, onclose does the retry
      // logic) — so a transient error during an active recording doesn't
      // jump straight to the terminal 'ws-error' stage before the retry
      // logic below even runs.
      console.log('[meeting ws] onerror event:', evt);
    };
    ws.onclose = (evt: { code?: number; reason?: string }) => {
      console.log('[meeting ws] onclose code:', evt?.code, 'reason:', evt?.reason);
      streamerRef.current?.stop().catch(() => {});
      streamerRef.current = null;
      if (endedIntentionallyRef.current) {
        // handleEnd() already called ws.close() itself — WS close code 1000
        // here is the expected clean closure for that, not an error. Reflect
        // the already-set 'ended' stage cleanly: no error message, no
        // error-styled UI.
        setStage('ended');
        return;
      }
      if (!isRecordingRef.current) {
        // Not actively recording (e.g. closed before ever reaching
        // 'connected', or cleanup() already ran) — nothing to reconnect.
        setStage('ws-error');
        setErrorMsg(
          `Connection closed (code ${evt?.code ?? 'unknown'}${evt?.reason ? `: ${evt.reason}` : ''}). Base: ${wsBase}.`
        );
        return;
      }
      // 2026-08-18 hardening: jittered backoff (250ms→8s) with a real ~60s
      // time budget as the primary give-up control (was: no-jitter
      // 1s→10s with a flat 8-attempt ceiling). Also raises the >2s
      // lapse-start notice (via the tracker's internal timer) and the
      // terminal give-up notice inline in the transcript — see
      // pushLapseStartNotice/pushLapseStoppedNotice above.
      setStage('reconnecting');
      setErrorMsg(
        `Connection lost (code ${evt?.code ?? 'unknown'}${evt?.reason ? `: ${evt.reason}` : ''}). Reconnecting…`
      );
      const result = tracker.onDisconnect();
      if ('giveUp' in result) {
        // Give up — same terminal 'ws-error' UI as before this change, just
        // reached via the time-budget/attempt-seatbelt tracker instead of a
        // flat attempt count. pushLapseStoppedNotice() already fired above
        // via onGiveUp.
        setStage('ws-error');
        setErrorMsg(
          `Lost connection and could not reconnect (${result.reason}) ` +
            `(last code ${evt?.code ?? 'unknown'}${evt?.reason ? `: ${evt.reason}` : ''}). Base: ${wsBase}.`
        );
        return;
      }
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (isRecordingRef.current && wsUrlRef.current) {
          connectWebSocket(wsUrlRef.current);
        }
      }, result.delayMs);
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

  // ── Smart auto-scroll (mirrors app/web/src/pages/MeetingPage.tsx's
  // handleTranscriptScroll() exactly) ────────────────────────────────────
  // Tracks whether the user has manually scrolled away from the live edge
  // by more than the threshold, so handleTranscriptContentSizeChange below
  // can skip auto-scrolling while they're reading back through earlier
  // lines — same nuance as web, not a blind force-scroll on every update.
  function handleTranscriptScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    userScrolledUpRef.current = distFromBottom > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }

  // Fires whenever the ScrollView's content grows (new final segment
  // appended, or interim text updated/cleared) — the RN equivalent of
  // web's `useEffect(() => { el.scrollTop = el.scrollHeight; }, [segments,
  // interimText])`. Only snaps to the bottom if the user hasn't scrolled
  // away from the live edge, exactly like web.
  function handleTranscriptContentSizeChange() {
    if (userScrolledUpRef.current) return;
    transcriptScrollRef.current?.scrollToEnd({ animated: false });
  }

  // Single finalize path for BOTH the manual "End Meeting" button and the
  // (2026-08-05) auto-stop-on-backgrounding guard above — intentionally not
  // duplicated: whichever caller reaches this first wins, and the
  // `endedIntentionallyRef` guard makes this idempotent against being
  // invoked twice (e.g. user taps "End Meeting" right as the app is also
  // being backgrounded).
  async function handleEnd() {
    if (endedIntentionallyRef.current) return; // already ending/ended — no-op
    endedIntentionallyRef.current = true;
    setStage('ended');
    userScrolledUpRef.current = false; // re-enable auto-scroll after recording — mirrors web's stopRecording()
    cleanup();
    if (meeting) {
      try {
        // Same backend contract as the manual "End Meeting" button always
        // used (PATCH /api/meetings/:id, status: 'completed') — no second
        // finalize code path for the auto-stop-on-backgrounding case. This
        // is a best-effort client-side finalize only: if the OS suspends
        // the process before this network call completes (see file header
        // reliability notes), the Objective 2 server-side WS-close fix is
        // the actual guarantee that the meeting still leaves 'active'.
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
          {/* 2026-08-04: was router.back() — standard stack-back, which
              could land on whatever screen happened to precede this one in
              nav history (e.g. Profile) depending on how the user reached
              this screen. Gabe flagged this as non-deterministic, especially
              once a meeting has ended: this button (same element at every
              stage on this screen) must always return to the Home tab —
              the meeting-history list — never "back one step" in history.
              router.replace (not push) so an ended meeting screen doesn't
              linger in the stack for the device back-gesture to return to.
              '/(tabs)' is the Home tab's real resolved route: per Expo
              Router's generated route types (.expo/types/router.d.ts), the
              tab group's root resolves to pathname `${'/(tabs)'}` | `/` —
              i.e. (tabs)/index.tsx (Home) IS that route.

              2026-08-05: hidden entirely while `stage === 'connected'` — a
              rep mid-recording should not have a readily-available way to
              navigate off this screen; the button only (re)appears once the
              recording has actually stopped/finalized (any stage other than
              'connected': pre-start, error, or ended). See the `beforeRemove`
              listener above for the matching Android hardware/gesture-back
              lockout covering the same 'connected' window. */}
          {stage !== 'connected' && (
            <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backButton}>
              <ThemedText type="link">← Back</ThemedText>
            </Pressable>
          )}

          {/* 2026-08-05 (later same day): the "In-Person Meeting" title was
              removed per feedback — this screen is getting more content and
              doesn't need a static meeting-type label taking up vertical
              space. This was a DISPLAY-ONLY removal: nothing about meeting
              type is tracked in this label (the meeting row created by
              `createMeeting()` and everything in src/lib/api.ts is
              untouched), so no data model change is implied. */}

          {/* 2026-08-05: one-time "don't leave the app" warning. Originally
              a persistent banner rendered for the whole recording (gated on
              `stage === 'connected'`); per feedback it now shows once at
              recording start and auto-dismisses after
              LEAVE_WARNING_VISIBLE_MS — hence gating on the
              `showLeaveWarning` timer state rather than on `stage`. This is
              the up-front half of the leave-app guard (see file header +
              the AppState listener above for the auto-stop half) — warn
              BEFORE the user backgrounds the app, not just react after.
              The auto-stop half is deliberately NOT touched by this change. */}
          {showLeaveWarning && (
            <ThemedView style={styles.leaveWarningBanner}>
              <ThemedText type="smallBold" style={styles.leaveWarningText}>
                ⚠️ Stay in this app while recording. Locking the screen or
                switching apps will stop the meeting.
              </ThemedText>
            </ThemedView>
          )}

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

          {/* 2026-08-04: 'ended' removed from this condition per Gabe's
              request — a completed meeting screen must not offer to start a
              brand-new meeting from here; the Home tab's Record flow is the
              one true way to start a fresh meeting now. 'idle' / 'mic-denied'
              / 'ws-error' are kept: those are still legitimate restart-from-
              this-same-screen cases (never started yet, or a real recoverable
              error), unlike 'ended' which means the recording already
              completed successfully. */}
          {/* (2026-08-10) 'reconnecting' added to the End-Meeting branch,
              not the Start-Meeting branch — mirrors web's isRecording-gated
              (not connectionStatus-gated) record button, see
              app/web/src/pages/MeetingPage.tsx: a transient reconnect is
              still an active, in-progress recording from the user's
              perspective, and they must still be able to tap End Meeting
              (which tears down the reconnect timer via cleanup()) rather
              than being shown the Start-Meeting button as if nothing were
              recording. */}
          {stage === 'idle' || stage === 'mic-denied' || stage === 'ws-error' ? (
            <Pressable onPress={handleStart} style={[styles.button, styles.startButton]}>
              <ThemedText style={styles.buttonText}>🎙️ Start Meeting</ThemedText>
            </Pressable>
          ) : stage === 'connected' || stage === 'reconnecting' ? (
            <Pressable onPress={handleEnd} style={[styles.button, styles.endButton]}>
              <ThemedText style={styles.buttonText}>⏹ End Meeting</ThemedText>
            </Pressable>
          ) : stage === 'ended' ? (
            // Nothing to offer here — the status card above already shows the
            // "Meeting ended" confirmation (see StatusRow's `ended` label),
            // and the ← Back button now deterministically routes Home (fix
            // above), which is the intended way to move on from this screen.
            null
          ) : (
            <ThemedView style={styles.loadingRow}>
              <ActivityIndicator />
              <ThemedText type="small" themeColor="textSecondary">
                {stageLabel(stage)}
              </ThemedText>
            </ThemedView>
          )}

          {/* 2026-08-04: moved below the Start/End button per Gabe's request —
              always rendered once a meeting exists for this screen session
              (not gated on stage === 'connected' alone), so the panel itself
              is visibly present — including its "Listening…" placeholder —
              even before any interim/final message has arrived. This makes
              it possible to see at a glance whether the UI is rendering vs.
              whether transcript data specifically isn't arriving over the WS. */}
          {meeting && (
            <ThemedView style={styles.transcriptCard}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.transcriptLabel}>
                LIVE TRANSCRIPT
              </ThemedText>
              <ScrollView
                ref={transcriptScrollRef}
                style={styles.transcriptScroll}
                onScroll={handleTranscriptScroll}
                onContentSizeChange={handleTranscriptContentSizeChange}
                scrollEventThrottle={100}>
                {segments.length === 0 && !interim && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {stage === 'connected' ? 'Listening…' : 'No transcript yet.'}
                  </ThemedText>
                )}
                {segments.map((seg) =>
                  // 2026-08-18 (Deepgram reconnect hardening) — a lapse/
                  // recovery/terminal-stop notice renders as an inline
                  // system banner instead of a speaker line. Mirrors web's
                  // TranscriptLapseNotice copy/behavior.
                  seg.kind ? (
                    <ThemedText key={seg.key} type="small" style={styles.lapseNotice}>
                      {lapseNoticeText(seg)}
                    </ThemedText>
                  ) : (
                    <ThemedText key={seg.key} type="small" style={styles.transcriptLine}>
                      <ThemedText type="smallBold">{seg.speaker}: </ThemedText>
                      {seg.text}
                    </ThemedText>
                  )
                )}
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

          {stage !== 'connected' && segments.length === 0 && !STREAMING_SUPPORTED_PLATFORM && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.stubNote}>
              Live audio streaming is iOS-only in this build.
            </ThemedText>
          )}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

// 2026-08-18 (Deepgram reconnect hardening) — lapse-notice copy, same
// wording/intent as web/src/pages/MeetingPage.tsx's TranscriptLapseNotice,
// so a rep sees the same message on mobile or web regardless of platform.
function lapseNoticeText(seg: TranscriptSegment): string {
  if (seg.kind === 'lapse-start') return '⚠️ Connection lost — live transcription paused. Recording continues.';
  if (seg.kind === 'lapse-end') {
    const ms = seg.lapseDurationMs;
    if (ms === undefined || !Number.isFinite(ms)) return '✅ Reconnected.';
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const dur = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
    return `✅ Reconnected — live transcription was paused for ${dur}.`;
  }
  if (seg.kind === 'lapse-stopped') {
    return '🛑 Live transcription has stopped for this meeting. The recording is still being captured — the transcript can be backfilled afterward.';
  }
  return '';
}

function stageLabel(stage: Stage): string {
  switch (stage) {
    case 'requesting-mic':
      return 'Requesting microphone permission…';
    case 'creating-meeting':
      return 'Creating meeting…';
    case 'connecting-ws':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
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
    reconnecting: { label: 'Reconnecting…', color: '#F59E0B' },
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
  leaveWarningBanner: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  leaveWarningText: { color: '#92400E' },
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
  lapseNotice: { marginBottom: Spacing.two, color: '#B45309', fontStyle: 'italic' },
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
