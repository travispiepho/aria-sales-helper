/**
 * meeting.tsx — Minimal "in-person meeting" screen (Stage 1 scope).
 *
 * What this DOES prove end-to-end:
 *   1. Requests microphone permission via expo-audio.
 *   2. Creates a meeting row via the EXISTING `POST /api/meetings` endpoint.
 *   3. Opens a WebSocket to the EXISTING `/meetings/:id/audio` endpoint —
 *      the exact same URL contract the web PWA uses (see
 *      app/web/src/pages/MeetingPage.tsx `getWsBase()` + `connectWebSocket()`).
 *   4. Shows a live connection-state badge (connecting/connected/error) once
 *      the WS handshake completes or fails.
 *
 * What this DOES NOT do yet (explicitly out of scope for this pass, flagged
 * as follow-up in memory/mobile-app-build-status-2026-08-03.md):
 *   - No actual PCM audio capture/streaming to the socket. The web app pipes
 *     mic audio through a Web Audio `AudioWorklet` (16kHz linear16 frames) —
 *     there is no equivalent Web Audio API in React Native. Streaming real
 *     mic audio from RN requires either a native audio-capture module (e.g.
 *     `expo-audio`'s recorder + reading raw PCM buffers, which needs
 *     verification of chunked/streaming support vs file-based recording) or
 *     a small native module. That's a real follow-up task, not a "few more
 *     lines" gap — deliberately NOT faked here.
 *   - No live transcript rendering (would require the above audio pipe to
 *     produce any `final`/`interim` server messages to render).
 *   - No reconnect/backoff logic (present in the web app, not ported yet).
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// expo-audio: mic permission only in this pass (see file header for why
// actual audio streaming is deferred).
import { requestRecordingPermissionsAsync } from 'expo-audio';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { createMeeting, getStoredSessionId, getWsBase, Meeting, updateMeeting } from '@/lib/api';

type Stage =
  | 'idle'
  | 'requesting-mic'
  | 'mic-denied'
  | 'creating-meeting'
  | 'connecting-ws'
  | 'connected'
  | 'ws-error'
  | 'ended';

export default function MeetingScreen() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('idle');
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  async function handleStart() {
    setErrorMsg(null);

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

    // Step 2: create meeting via existing backend contract (POST /api/meetings)
    setStage('creating-meeting');
    let created: Meeting;
    try {
      created = await createMeeting();
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
    const wsUrl = `${getWsBase()}/meetings/${created.id}/audio${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStage('connected');
    };
    ws.onerror = () => {
      setStage('ws-error');
      setErrorMsg('WebSocket connection failed. Check network/backend URL.');
    };
    ws.onclose = () => {
      // Only treat as an error if we hadn't already ended intentionally.
      setStage((prev) => (prev === 'ended' ? prev : 'ws-error'));
    };
    ws.onmessage = (evt) => {
      // Stage 1: not rendering transcript yet — just log for now so the
      // handshake + any server messages are visible during manual testing.
      console.log('[meeting ws] message:', evt.data);
    };
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
            {meeting && (
              <ThemedText type="small" themeColor="textSecondary">
                Meeting ID: {meeting.id}
              </ThemedText>
            )}
          </ThemedView>

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

          <ThemedText type="small" themeColor="textSecondary" style={styles.stubNote}>
            Note: this proves mic permission + WebSocket handshake only.
            Live audio streaming/transcription is stubbed — see build status
            doc for follow-up scope.
          </ThemedText>
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
    connected: { label: 'Connected — listening', color: '#16A34A' },
    'ws-error': { label: 'Connection error', color: '#DC2626' },
    ended: { label: 'Meeting ended', color: '#6B7280' },
  };
  const { label, color } = map[stage];
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
