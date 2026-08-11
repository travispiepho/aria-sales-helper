/**
 * (tabs)/_layout.tsx — Bottom tab bar for ARIA mobile (2026-08-04).
 *
 * Three tabs per Troy's request:
 *   - Home (left)   → previous-transcripts / meeting history list (index.tsx)
 *   - Record (center) → visually prominent FAB-style button that launches
 *     the meeting flow. It is NOT a real destination screen — its
 *     `tabPress` is intercepted (preventDefault) and redirected to
 *     `router.push('/meeting-setup')`, which lives OUTSIDE this tab group
 *     (see root _layout.tsx) so the recording screen renders full-screen
 *     without the tab bar competing for space with the live transcript
 *     panel. This is the standard Expo Router / React Navigation pattern
 *     for a "launcher" tab (e.g. a camera-shutter center button) that opens
 *     a modal/full-screen flow rather than switching to a persisted tab.
 *     (2026-08-10) Changed from pushing straight to `/meeting` to pushing
 *     to the new `/meeting-setup` pre-recording step (channel + device
 *     selection) — see meeting-setup.tsx's header for the full design.
 *     `/meeting-setup` itself pushes on to `/meeting` once the user has
 *     made both choices there; the EXISTING recording screen/flow at
 *     `/meeting` is otherwise completely unchanged.
 *   - Profile (right) → basic account screen (profile.tsx)
 *
 * The center button's distinct styling (larger, raised, colored) is done
 * entirely via a custom `tabBarButton` on the "record" screen's options —
 * no custom from-scratch tab bar, per the task's stated preference. This
 * uses Expo Router's standard `Tabs` (backed by
 * `@react-navigation/bottom-tabs`), which explicitly supports per-tab
 * `tabBarButton` overrides for exactly this "prominent center action"
 * pattern.
 */

import { Tabs, useRouter } from 'expo-router';
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/hooks/use-theme';

export default function TabsLayout() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#208AEF',
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopColor: theme.backgroundSelected,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />

      <Tabs.Screen
        name="record"
        options={{
          title: 'Record',
          // The label under the icon is suppressed by the custom button
          // below, but keep a title for a11y (screen readers / tab bar
          // accessibility label fallback).
          tabBarButton: (props) => <RecordTabButton {...props} />,
        }}
        listeners={{
          tabPress: (e) => {
            // Never actually navigate to this tab's own (unreachable) screen
            // — launch the pre-recording setup step instead (see file
            // header: meeting-setup.tsx now sits in front of the existing
            // full-screen meeting flow).
            e.preventDefault();
            router.push('/meeting-setup');
          },
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

// ─── Prominent center "Record Meeting" button ──────────────────────────────
// Raised circular FAB-in-tab-bar per common pattern (e.g. camera apps).
// Rendered via Expo Router/React Navigation's per-tab `tabBarButton` slot,
// so it lives inside the standard tab bar layout rather than a hand-rolled
// absolutely-positioned overlay.

function RecordTabButton(props: BottomTabBarButtonProps) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel="Record Meeting"
      style={styles.recordButtonWrap}>
      <View style={styles.recordButton}>
        <Ionicons name="mic" size={30} color="#fff" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  recordButtonWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    top: -18, // raise above the tab bar line
  },
  recordButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#16A34A',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
    borderWidth: 3,
    borderColor: '#fff',
  },
});
