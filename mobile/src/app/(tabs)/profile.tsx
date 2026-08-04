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

import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

export default function ProfileScreen() {
  const { user, logout, loading } = useAuth();

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
        <ThemedView style={styles.container}>
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

          <Pressable
            onPress={logout}
            style={({ pressed }) => [styles.logoutButton, pressed && styles.logoutPressed]}>
            <ThemedText style={styles.logoutText}>Sign Out</ThemedText>
          </Pressable>
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { flex: 1, padding: Spacing.four, gap: Spacing.four },
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
    marginTop: 'auto',
    borderWidth: 1,
    borderColor: '#DC2626',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  logoutPressed: { opacity: 0.7 },
  logoutText: { color: '#DC2626', fontWeight: '700', fontSize: 16 },
});
