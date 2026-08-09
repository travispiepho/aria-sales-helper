/**
 * (tabs)/profile.tsx — Profile tab.
 *
 * Minimal per the task scope ("a working stub that fits the new nav
 * pattern is the goal, not a fully-featured settings screen"): shows the
 * logged-in user's name/email/role (from GET /api/auth/me via useAuth(),
 * see src/lib/auth.tsx + src/lib/api.ts — no new backend calls invented)
 * and hooks into the EXISTING logout() from AuthProvider (src/lib/auth.tsx),
 * same clean action the old index.tsx dashboard used.
 *
 * Reference UI: app/web/src/pages/ProfilePage.tsx (avatar/name/email card +
 * sign-out button) — voice-print enrollment UI intentionally NOT ported
 * here; that's a separate feature, out of scope for a navigation-only pass.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { changePassword } from '@/lib/api';

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
