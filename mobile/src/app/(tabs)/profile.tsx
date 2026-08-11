/**
 * (tabs)/profile.tsx — Profile tab.
 *
 * Shows the logged-in user's name/email/role (from GET /api/auth/me via
 * useAuth(), see src/lib/auth.tsx + src/lib/api.ts — no new backend calls
 * invented) and hooks into the EXISTING logout() from AuthProvider
 * (src/lib/auth.tsx), same clean action the old index.tsx dashboard used.
 *
 * Reference UI: app/web/src/pages/ProfilePage.tsx (avatar/name/email card,
 * Voice Recognition card, Change Password card, sign-out button).
 *
 * (2026-08-10) Voice Recognition section ported from ProfilePage.tsx per
 * Gabe's request. Same functional behavior as web: GET enrollment status
 * on mount, a record button that captures a 30s on-device voice sample,
 * extracts voice features, POSTs to the EXISTING `/api/profile/voice-print`
 * endpoint, refreshes status, and a Remove button (DELETE). The actual
 * on-device recording/feature-extraction plumbing lives in
 * `src/lib/voiceEnrollment.ts` + `src/lib/voiceFeatures.ts` (ported from
 * web's `src/lib/voiceFeatures.ts`) — see those files' headers for the
 * full web→mobile port writeup (browser MediaRecorder/AnalyserNode APIs
 * don't exist in React Native; this reuses the SAME expo-audio recorder
 * + WAV-decoding pieces already proven for live meeting audio streaming
 * in `src/lib/audioStream.ts`, not a new audio stack). iOS-only for now,
 * same platform constraint already documented/accepted for meeting audio
 * streaming (Android's expo-audio/MediaRecorder backend has no raw-PCM
 * output option) — the Android UI shows a clear explanatory message
 * instead of silently failing or sending corrupt data.
 */

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAudioRecorder } from 'expo-audio';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { changePassword, deleteVoicePrint, getVoicePrintStatus, saveVoicePrint, VoicePrintStatus } from '@/lib/api';
import {
  ENROLL_DURATION_MS,
  ENROLLMENT_SUPPORTED_PLATFORM,
  getEnrollmentRecorderOptions,
  MIN_FRAME_COUNT,
  VoiceEnrollmentRecorder,
} from '@/lib/voiceEnrollment';

export default function ProfileScreen() {
  const { user, logout, loading } = useAuth();

  // Change Password (2026-08-08 fast-follow to web's ProfilePage.tsx —
  // mirrors that flow: current password re-verified server-side, see
  // PATCH /api/account/password in server.js).
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  // Voice Recognition (2026-08-10, ported from web's ProfilePage.tsx voice
  // enrollment flow — see this file's header + src/lib/voiceEnrollment.ts
  // for the full port writeup).
  const [vpStatus, setVpStatus] = useState<VoicePrintStatus | null>(null);
  const [vpLoading, setVpLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [vpSaving, setVpSaving] = useState(false);
  const [vpMsg, setVpMsg] = useState('');

  const audioRecorder = useAudioRecorder(getEnrollmentRecorderOptions());
  const enrollmentRef = useRef<VoiceEnrollmentRecorder | null>(null);
  const startTimeRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVoicePrintStatus()
      .then((data) => {
        if (!cancelled) setVpStatus(data);
      })
      .catch(() => {
        if (!cancelled) setVpStatus({ enrolled: false });
      })
      .finally(() => {
        if (!cancelled) setVpLoading(false);
      });
    return () => {
      cancelled = true;
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      enrollmentRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopElapsedTimer() {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  async function handleStartRecording() {
    setVpMsg('');
    if (!ENROLLMENT_SUPPORTED_PLATFORM) {
      setVpMsg('❌ Voice enrollment recording is not yet supported on Android in this build.');
      return;
    }
    try {
      const controller = new VoiceEnrollmentRecorder(audioRecorder);
      enrollmentRef.current = controller;
      await controller.start();
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      elapsedTimerRef.current = setInterval(() => {
        const el = Date.now() - startTimeRef.current;
        setElapsedMs(el);
        if (el >= ENROLL_DURATION_MS) {
          handleStopAndSave();
        }
      }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setVpMsg(`❌ Could not start recording: ${msg}`);
    }
  }

  async function handleStopAndSave() {
    stopElapsedTimer();
    setRecording(false);
    setElapsedMs(0);

    const controller = enrollmentRef.current;
    if (!controller) return;

    setVpSaving(true);
    setVpMsg('Analyzing voice…');
    try {
      const result = await controller.stopAndExtract();
      if (!result) {
        setVpMsg('❌ No audio captured. Try again.');
        setVpSaving(false);
        return;
      }
      if (result.features.frame_count < MIN_FRAME_COUNT) {
        setVpMsg('❌ Not enough speech detected. Please speak clearly and try again.');
        setVpSaving(false);
        return;
      }
      await saveVoicePrint(result.features, result.durationMs);
      const updated = await getVoicePrintStatus();
      setVpStatus(updated);
      setVpMsg('✅ Voice enrolled successfully!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save voice print. Try again.';
      setVpMsg(`❌ ${msg}`);
    } finally {
      setVpSaving(false);
      enrollmentRef.current = null;
    }
  }

  async function handleDeleteVoicePrint() {
    setVpMsg('');
    try {
      await deleteVoicePrint();
      setVpStatus({ enrolled: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove voice enrollment.';
      setVpMsg(`❌ ${msg}`);
    }
  }

  const vpProgressPct = Math.min((elapsedMs / ENROLL_DURATION_MS) * 100, 100);
  const vpSecondsLeft = Math.max(0, Math.ceil((ENROLL_DURATION_MS - elapsedMs) / 1000));

  async function handleChangePassword() {
    setPwMsg(null);
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPwMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }
    if (newPassword.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'New password and confirmation do not match.' });
      return;
    }
    setPwSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPwMsg({ type: 'success', text: 'Password changed successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to change password.' });
    } finally {
      setPwSaving(false);
    }
  }

  if (loading || !user) {
    return (
      <ThemedView style={styles.centerFill}>
        <ActivityIndicator size="large" />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={['top']}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <ThemedText type="title" style={styles.title}>
            Profile
          </ThemedText>

          <ThemedView style={styles.card} type="backgroundElement">
            <ThemedView style={styles.avatar} type="backgroundSelected">
              <ThemedText type="title" style={styles.avatarText}>
                {user.name?.charAt(0)?.toUpperCase() || '?'}
              </ThemedText>
            </ThemedView>
            <ThemedText type="smallBold" style={styles.name}>
              {user.name}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {user.email}
            </ThemedText>
            <ThemedView style={styles.rolePill} type="backgroundSelected">
              <ThemedText type="small" style={styles.roleText}>
                {user.role}
              </ThemedText>
            </ThemedView>
          </ThemedView>

          <ThemedView style={styles.vpCard} type="backgroundElement">
            <ThemedText type="smallBold" style={styles.vpTitle}>
              🎙️ Voice Recognition
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.vpSubtitle}>
              Record a 30-second voice sample so ARIA can automatically identify you during meetings — no more manual speaker labeling.
            </ThemedText>

            {vpLoading ? (
              <ActivityIndicator />
            ) : (
              <>
                {vpStatus?.enrolled && !recording && (
                  <View style={styles.vpEnrolledBanner}>
                    <ThemedView style={styles.vpEnrolledTextWrap}>
                      <ThemedText type="small" style={styles.vpEnrolledText}>
                        ✅ Voice enrolled
                      </ThemedText>
                      {vpStatus.created_at && (
                        <ThemedText type="small" themeColor="textSecondary">
                          Enrolled{' '}
                          {new Date(vpStatus.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </ThemedText>
                      )}
                    </ThemedView>
                    <Pressable onPress={handleDeleteVoicePrint}>
                      <ThemedText type="small" style={styles.vpRemoveText}>
                        Remove
                      </ThemedText>
                    </Pressable>
                  </View>
                )}

                {recording ? (
                  <ThemedView style={styles.vpRecordingWrap}>
                    <ThemedView style={styles.vpRecordingBanner}>
                      <ThemedView style={styles.vpRecordingHeaderRow}>
                        <ThemedText type="small" style={styles.vpRecordingLabel}>
                          ● Recording…
                        </ThemedText>
                        <ThemedText type="small" style={styles.vpRecordingLabel}>
                          {vpSecondsLeft}s left
                        </ThemedText>
                      </ThemedView>
                      <ThemedView style={styles.vpProgressTrack}>
                        <ThemedView style={[styles.vpProgressFill, { width: `${vpProgressPct}%` }]} />
                      </ThemedView>
                      <ThemedText type="small" style={styles.vpRecordingHint}>
                        Speak naturally — describe a room, read anything aloud, or just talk.
                      </ThemedText>
                    </ThemedView>
                    <Pressable
                      onPress={handleStopAndSave}
                      disabled={vpSaving}
                      style={({ pressed }) => [styles.vpStopButton, pressed && styles.pwButtonPressed, vpSaving && styles.pwButtonDisabled]}>
                      <ThemedText style={styles.vpStopButtonText}>{vpSaving ? 'Saving…' : 'Stop & Save Early'}</ThemedText>
                    </Pressable>
                  </ThemedView>
                ) : (
                  <Pressable
                    onPress={handleStartRecording}
                    disabled={vpSaving}
                    style={({ pressed }) => [styles.vpButton, pressed && styles.pwButtonPressed, vpSaving && styles.pwButtonDisabled]}>
                    <ThemedText style={styles.pwButtonText}>
                      🎙️ {vpStatus?.enrolled ? 'Re-record Voice Sample' : 'Record Voice Sample (30s)'}
                    </ThemedText>
                  </Pressable>
                )}

                {!ENROLLMENT_SUPPORTED_PLATFORM && !recording && (
                  <ThemedText type="small" themeColor="textSecondary" style={styles.vpPlatformNote}>
                    Voice enrollment recording currently requires iOS — Android support is not yet available in this build.
                  </ThemedText>
                )}

                {vpMsg && (
                  <ThemedText type="small" style={[styles.vpMsg, vpMsg.startsWith('✅') ? styles.pwSuccess : vpMsg.startsWith('❌') ? styles.pwError : undefined]}>
                    {vpMsg}
                  </ThemedText>
                )}
              </>
            )}
          </ThemedView>

          <ThemedView style={styles.pwCard} type="backgroundElement">
            <ThemedText type="smallBold" style={styles.pwTitle}>
              Change Password
            </ThemedText>
            <TextInput
              style={styles.input}
              placeholder="Current Password"
              secureTextEntry
              textContentType="password"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              editable={!pwSaving}
            />
            <TextInput
              style={styles.input}
              placeholder="New Password"
              secureTextEntry
              textContentType="newPassword"
              value={newPassword}
              onChangeText={setNewPassword}
              editable={!pwSaving}
            />
            <TextInput
              style={styles.input}
              placeholder="Confirm New Password"
              secureTextEntry
              textContentType="newPassword"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              editable={!pwSaving}
              onSubmitEditing={handleChangePassword}
            />
            {pwMsg && (
              <ThemedText type="small" style={pwMsg.type === 'success' ? styles.pwSuccess : styles.pwError}>
                {pwMsg.text}
              </ThemedText>
            )}
            <Pressable
              onPress={handleChangePassword}
              disabled={pwSaving}
              style={({ pressed }) => [styles.pwButton, pressed && styles.pwButtonPressed, pwSaving && styles.pwButtonDisabled]}>
              {pwSaving ? <ActivityIndicator color="#fff" /> : <ThemedText style={styles.pwButtonText}>Update Password</ThemedText>}
            </Pressable>
          </ThemedView>

          <Pressable
            onPress={logout}
            style={({ pressed }) => [styles.logoutButton, pressed && styles.logoutPressed]}>
            <ThemedText style={styles.logoutText}>Sign Out</ThemedText>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: Spacing.four, gap: Spacing.four, flexGrow: 1 },
  title: { fontSize: 28, lineHeight: 34 },
  card: { borderRadius: Spacing.three, padding: Spacing.four, alignItems: 'center', gap: Spacing.one },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
  },
  avatarText: { fontSize: 24, lineHeight: 28 },
  name: { fontSize: 16 },
  rolePill: { marginTop: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: 4, borderRadius: 999 },
  roleText: { textTransform: 'capitalize' },
  vpCard: { borderRadius: Spacing.three, padding: Spacing.four, gap: Spacing.two },
  vpTitle: { marginBottom: 0 },
  vpSubtitle: { marginBottom: Spacing.one },
  vpEnrolledBanner: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    backgroundColor: 'transparent',
  },
  vpEnrolledTextWrap: { gap: 2, flexShrink: 1 },
  vpEnrolledText: { color: '#16A34A', fontWeight: '600' },
  vpRemoveText: { color: '#DC2626', fontWeight: '600' },
  vpRecordingWrap: { gap: Spacing.two },
  vpRecordingBanner: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    backgroundColor: '#FEF2F2',
    padding: Spacing.three,
    gap: Spacing.one,
  },
  vpRecordingHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  vpRecordingLabel: { color: '#B91C1C', fontWeight: '600' },
  vpProgressTrack: { height: 8, borderRadius: 4, backgroundColor: '#FECACA', overflow: 'hidden' },
  vpProgressFill: { height: '100%', borderRadius: 4, backgroundColor: '#EF4444' },
  vpRecordingHint: { color: '#B91C1C' },
  vpStopButton: {
    backgroundColor: '#1F2937',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vpStopButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  vpButton: {
    backgroundColor: '#208AEF',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vpPlatformNote: { fontStyle: 'italic' },
  vpMsg: { textAlign: 'center' },
  logoutButton: {
    borderWidth: 1,
    borderColor: '#DC2626',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  logoutPressed: { opacity: 0.7 },
  logoutText: { color: '#DC2626', fontWeight: '700', fontSize: 16 },
  pwCard: { borderRadius: Spacing.three, padding: Spacing.four, gap: Spacing.two },
  pwTitle: { marginBottom: Spacing.one },
  input: {
    borderWidth: 1,
    borderColor: '#D0D2D8',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  pwError: { color: '#DC2626' },
  pwSuccess: { color: '#16A34A' },
  pwButton: {
    backgroundColor: '#208AEF',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.one,
  },
  pwButtonPressed: { opacity: 0.8 },
  pwButtonDisabled: { opacity: 0.6 },
  pwButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
