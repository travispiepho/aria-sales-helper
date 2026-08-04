import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, useColorScheme } from 'react-native';

import { ThemedView } from '@/components/themed-view';
import { AuthProvider, useAuth } from '@/lib/auth';

// Root layout (restructured 2026-08-04 for the bottom tab-bar nav change —
// see memory/aria-mobile-bottom-nav-2026-08-04.md for the full report).
//
// Route tree:
//   login            — sign-in screen (guarded: only reachable when signed out)
//   (tabs)/index     — Home tab: previous-meetings / transcript history list
//   (tabs)/record    — center tab; its tabPress is intercepted (see
//                      (tabs)/_layout.tsx) to push /meeting instead of ever
//                      actually rendering this route
//   (tabs)/profile   — Profile tab: basic account info + sign out
//   meeting          — UNCHANGED in-person recording screen (moved out of
//                      the tab group so it renders full-screen, without the
//                      tab bar, exactly as it did before this restructure —
//                      its internal logic was not touched, only its
//                      reachability: previously the only screen pushed from
//                      the old single index.tsx dashboard, now pushed from
//                      the record tab's intercepted tabPress instead)
//   meetings/[id]    — meeting detail/transcript view, reached from the
//                      Home tab's history list
//
// Auth gating uses Expo Router's built-in `Stack.Protected` (guard) API
// instead of a hand-rolled redirect effect, so unauthenticated users are
// structurally unable to navigate to any tab/meeting screen.
export default function RootLayout() {
  return (
    <AuthProvider>
      <ThemedRoot />
    </AuthProvider>
  );
}

function ThemedRoot() {
  const colorScheme = useColorScheme();
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <ThemedView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" />
        </ThemedView>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!!user}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="meeting" />
          <Stack.Screen name="meetings/[id]" />
        </Stack.Protected>
        <Stack.Protected guard={!user}>
          <Stack.Screen name="login" />
        </Stack.Protected>
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
