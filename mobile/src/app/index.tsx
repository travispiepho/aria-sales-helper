import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

export default function HomeScreen() {
  const { user, loading, login, logout } = useAuth();

  if (loading) {
    return (
      <ThemedView style={styles.centerFill}>
        <ActivityIndicator size="large" />
      </ThemedView>
    );
  }

  if (!user) {
    return <LoginScreen onLogin={login} />;
  }

  return <HomeDashboard userName={user.name} onLogout={logout} />;
}

// ─── Login screen ───────────────────────────────────────────────────────────
// Calls the EXISTING backend contract: POST /api/auth/login { email, password }
// (see app/server/server.js and src/lib/api.ts for the full auth notes).

function LoginScreen({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setSubmitting(true);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ThemedView style={styles.fill}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView style={styles.fill}>
          <ThemedView style={styles.loginContainer}>
            <ThemedText type="title" style={styles.loginTitle}>
              ARIA
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.loginSubtitle}>
              Sales Helper — sign in
            </ThemedText>

            <ThemedView style={styles.form}>
              <TextInput
                style={styles.input}
                placeholder="Email"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                value={email}
                onChangeText={setEmail}
                editable={!submitting}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                secureTextEntry
                textContentType="password"
                value={password}
                onChangeText={setPassword}
                editable={!submitting}
                onSubmitEditing={handleSubmit}
              />

              {error && (
                <ThemedText type="small" style={styles.error}>
                  {error}
                </ThemedText>
              )}

              <Pressable
                onPress={handleSubmit}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.button,
                  pressed && styles.buttonPressed,
                  submitting && styles.buttonDisabled,
                ]}>
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <ThemedText style={styles.buttonText}>Sign In</ThemedText>
                )}
              </Pressable>
            </ThemedView>
          </ThemedView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

// ─── Home / dashboard (post-login) ─────────────────────────────────────────

function HomeDashboard({ userName, onLogout }: { userName: string; onLogout: () => void }) {
  const router = useRouter();

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ThemedView style={styles.dashboard}>
          <ThemedText type="title" style={styles.loginTitle}>
            ARIA
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Signed in as {userName}
          </ThemedText>

          <Pressable
            onPress={() => router.push('/meeting')}
            style={({ pressed }) => [styles.button, styles.meetingButton, pressed && styles.buttonPressed]}>
            <ThemedText style={styles.buttonText}>🎙️ Start In-Person Meeting</ThemedText>
          </Pressable>

          <Pressable onPress={onLogout} style={styles.logoutButton}>
            <ThemedText type="small" themeColor="textSecondary">
              Sign out
            </ThemedText>
          </Pressable>
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loginContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  loginTitle: { textAlign: 'center', color: '#fff' },
  loginSubtitle: { textAlign: 'center', marginTop: Spacing.one, marginBottom: Spacing.five, color: '#fff' },
  form: { gap: Spacing.three },
  input: {
    borderWidth: 1,
    borderColor: '#D0D2D8',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
    color: '#fff',
  },
  error: { color: '#DC2626', textAlign: 'center' },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  dashboard: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },
  meetingButton: { marginTop: Spacing.five, backgroundColor: '#16A34A' },
  logoutButton: { alignItems: 'center', paddingVertical: Spacing.three },
});
