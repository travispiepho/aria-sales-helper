/**
 * login.tsx — Sign-in screen.
 *
 * Extracted verbatim (logic unchanged) from the old src/app/index.tsx's
 * `LoginScreen` component as part of the 2026-08-04 bottom-nav restructure.
 * Only reached when the root layout's `Stack.Protected guard={!user}` is
 * active — see src/app/_layout.tsx. Calls the EXISTING backend contract:
 * POST /api/auth/login { email, password } (see app/server/server.js and
 * src/lib/api.ts for the full auth notes).
 */

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

export default function LoginScreen() {
  const { login } = useAuth();
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
      await login(email.trim(), password);
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
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
});
