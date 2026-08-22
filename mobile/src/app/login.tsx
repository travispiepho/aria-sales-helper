import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
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
  async function submit() {
    setError(null);
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setSubmitting(true);
    try { await login(email.trim(), password); }
    catch (err) { setError(err instanceof Error ? err.message : 'Login failed.'); }
    finally { setSubmitting(false); }
  }
  return <ThemedView style={styles.fill}><KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><SafeAreaView style={styles.fill}><View style={styles.screen}>
    <View style={styles.brand}><View style={styles.logo}><ThemedText style={styles.logoText}>S</ThemedText></View><ThemedText type="title" style={styles.brandTitle}>ARIA</ThemedText><ThemedText type="small" style={styles.brandSubtitle}>CertaPro Grand Haven</ThemedText></View>
    <View style={styles.formCard}>
      {error && <View style={styles.errorBox}><ThemedText type="small" style={styles.errorText}>{error}</ThemedText></View>}
      <ThemedText type="smallBold" style={styles.label}>Email</ThemedText>
      <TextInput style={styles.input} placeholder="you@certapro.com" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} editable={!submitting} />
      <ThemedText type="smallBold" style={styles.label}>Password</ThemedText>
      <TextInput style={styles.input} placeholder="••••••••" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} editable={!submitting} onSubmitEditing={submit} />
      <Pressable onPress={submit} disabled={submitting} style={({ pressed }) => [styles.button, pressed && styles.pressed, submitting && styles.disabled]}>{submitting ? <ActivityIndicator color="#fff" /> : <ThemedText style={styles.buttonText}>Sign In</ThemedText>}</Pressable>
      <ThemedText type="small" themeColor="textSecondary" style={styles.invite}>Have an invite code? <ThemedText type="smallBold" style={styles.inviteLink}>Claim your account</ThemedText></ThemedText>
    </View>
  </View></SafeAreaView></KeyboardAvoidingView></ThemedView>;
}
const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#1D4ED8' }, screen: { flex: 1, backgroundColor: '#1D4ED8', justifyContent: 'center', paddingHorizontal: Spacing.four }, brand: { alignItems: 'center', marginBottom: Spacing.five }, logo: { width: 66, height: 66, borderRadius: 18, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.three, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, elevation: 5 }, logoText: { color: '#1D4ED8', fontSize: 32, fontWeight: '900' }, brandTitle: { color: '#fff', fontSize: 27 }, brandSubtitle: { color: '#DBEAFE', marginTop: 4 }, formCard: { backgroundColor: '#fff', borderRadius: 20, padding: Spacing.four, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, elevation: 8 }, label: { color: '#374151', marginBottom: 6, marginTop: Spacing.two }, input: { minHeight: 52, borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 12, paddingHorizontal: Spacing.three, color: '#111827', fontSize: 16, backgroundColor: '#fff' }, errorBox: { backgroundColor: '#FEF2F2', padding: Spacing.three, borderRadius: 10, marginBottom: Spacing.two }, errorText: { color: '#B91C1C' }, button: { backgroundColor: '#1D4ED8', borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: Spacing.four }, buttonText: { color: '#fff', fontWeight: '900', fontSize: 16 }, invite: { textAlign: 'center', marginTop: Spacing.three }, inviteLink: { color: '#1D4ED8' }, pressed: { opacity: 0.78 }, disabled: { opacity: 0.55 } });
