/**
 * (tabs)/record.tsx — placeholder route for the center tab.
 *
 * This screen is never actually shown in normal use: the tab bar's
 * `tabPress` listener (see _layout.tsx) intercepts the press with
 * `preventDefault()` and pushes `/meeting` (a full-screen route outside this
 * tab group) instead of switching to this tab. This file only exists
 * because Expo Router's file-based Tabs navigator requires a real route
 * file backing every `<Tabs.Screen name="record" />` entry.
 *
 * As a defensive fallback (e.g. a deep link or programmatic
 * `router.push('/(tabs)/record')` bypassing the tabPress listener), redirect
 * straight to the meeting flow so this route is never a dead end.
 */

import { Redirect } from 'expo-router';

export default function RecordTabFallback() {
  return <Redirect href="/meeting" />;
}
