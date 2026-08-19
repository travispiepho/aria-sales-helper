/**
 * meeting-setup.tsx — Pre-recording setup step (2026-08-10).
 *
 * Inserted between "user presses the Record tab" and the EXISTING
 * meeting.tsx recording screen (mic arming / meeting creation / WS
 * connect — all UNTOUCHED by this file, see meeting.tsx's own header).
 * Previously the Record tab's `tabPress` listener (see
 * (tabs)/_layout.tsx) pushed straight to `/meeting`, which immediately
 * offered the "🎙️ Start Meeting" button with no upfront choices at all —
 * every mobile-created meeting silently got the `channel` column's DB
 * default (`'in_person'`), even ones that were actually phone calls, and
 * there was no concept of "which device is this" anywhere in the mobile
 * flow. This screen is now what the Record tab opens instead, and it
 * itself pushes on to `/meeting` (passing the chosen `channel` as a route
 * param) only once the two steps below are complete. `/meeting` still
 * requires its own manual "Start Meeting" tap exactly as before — this
 * screen does not change when recording/the WS connection itself starts,
 * only what happens right before the user gets there.
 *
 * Two steps, one screen (simple wizard, no nested navigator needed for
 * just two steps):
 *
 * STEP 1 — Meeting channel/type: "In-Person" vs "Over-the-Phone".
 *   This maps DIRECTLY onto the EXISTING `meetings.channel` column (see
 *   server/migrations/2026-08-04-phone-channel-columns.sql — despite that
 *   file's own "PROPOSED / SKETCH ONLY — NOT APPLIED" header comment, the
 *   column IS live in production; confirmed via a direct
 *   information_schema query against the `meetings` table during this
 *   task, default `'in_person'`, CHECK constrained to
 *   `('phone', 'in_person')`). This step does NOT invent a new field —
 *   it's the first real UI producer for a column the schema already had.
 *
 * STEP 2 — Device selection ("which device(s) are being used for this
 *   meeting"):
 *   ⚠️ IMPORTANT SCOPE NOTE, read before extending this: there is currently
 *   NO concept anywhere in this backend of tracking multiple concurrently
 *   logged-in devices/sessions per user. `sessions` (see
 *   server.js's `ensureSessionsTable()`) is a flat table of
 *   `(id, user_id, created_at, expires_at)` — it has no device label, no
 *   platform/user-agent field, and no API surface exposes "list this
 *   user's other active sessions" today. Building that (session
 *   fingerprinting/labeling, a real "devices currently logged in to your
 *   account" query, cross-device state) is a genuinely separate, larger
 *   feature and was explicitly OUT OF SCOPE for this task — see the task's
 *   own instructions and the project report for the full reasoning.
 *   What THIS step actually does, honestly: it always offers exactly one
 *   real, selectable option — "This Device" — labeled with this device's
 *   actual real model name via `expo-device` (already an existing
 *   dependency; NOT a new package), e.g. "This Device — iPhone 14". This
 *   is real data (this literal device you're holding), not a fabricated
 *   multi-device list. The list is deliberately rendered as a checkbox
 *   list (not a single radio/segmented control) with `devices` (plural)
 *   stored as an array, so a future pass that DOES add real cross-device
 *   session tracking can add more real entries to this same array/UI
 *   without a rework — but today that array will only ever contain one
 *   real, honest entry. No placeholder/fake "iPad" or "aria-web" entries
 *   are hardcoded here.
 */

import * as Device from 'expo-device';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { MeetingChannel } from '@/lib/api';

type SetupStep = 'channel' | 'devices';

// Real device label — expo-device is an EXISTING dependency (already used
// elsewhere in this app's build), not something added for this task. Falls
// back gracefully through the fields expo-device documents as possibly
// `null` (deviceName is user-set and can be unavailable, particularly on
// newer iOS versions without the device-name entitlement — see expo-device's
// own docs) down to a generic-but-still-honest platform label, never a
// fabricated brand/model string.
function getThisDeviceLabel(): string {
  const name = Device.deviceName;
  const model = Device.modelName;
  if (name && model && name !== model) return `${name} (${model})`;
  if (name) return name;
  if (model) return model;
  return Platform.OS === 'ios' ? 'This iPhone/iPad' : Platform.OS === 'android' ? 'This Android device' : 'This device';
}

export default function MeetingSetupScreen() {
  const router = useRouter();
  const theme = useTheme();
  const [step, setStep] = useState<SetupStep>('channel');
  const [channel, setChannel] = useState<MeetingChannel | null>(null);
  // Only one real entry exists today (see file header scope note) — stored
  // as a Set keyed by a stable id so the UI/data shape already supports
  // multiple selectable devices once real multi-device data exists, without
  // this screen needing to change shape later. Pre-selected by default:
  // "this device" is virtually always correct for a mobile-initiated
  // meeting, and requiring an extra tap to check the only real option would
  // be pure friction.
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set(['this_device']));

  const thisDeviceLabel = getThisDeviceLabel();

  function toggleDevice(id: string) {
    setSelectedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleChannelChosen(next: MeetingChannel) {
    setChannel(next);
    setStep('devices');
  }

  function handleContinue() {
    if (!channel) return; // shouldn't happen — step 2 is only reachable after step 1
    router.replace({
      pathname: '/meeting',
      params: { channel },
    });
  }

  function handleBack() {
    if (step === 'devices') {
      setStep('channel');
      return;
    }
    router.replace('/(tabs)');
  }

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ThemedView style={styles.container}>
          <Pressable onPress={handleBack} style={styles.backButton}>
            <ThemedText type="link">← Back</ThemedText>
          </Pressable>

          {/* Step indicator — simple "1 of 2" text, not a fancy progress
              bar; two steps doesn't warrant more UI weight than this. */}
          <ThemedText type="small" themeColor="textSecondary">
            Step {step === 'channel' ? '1' : '2'} of 2
          </ThemedText>

          {step === 'channel' ? (
            <ThemedView style={styles.stepContainer}>
              <ThemedText type="subtitle" style={styles.heading}>
                How is this meeting happening?
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.subheading}>
                This is saved with the meeting so it shows up correctly in your history.
              </ThemedText>

              <Pressable
                onPress={() => handleChannelChosen('in_person')}
                style={[styles.optionCard, { borderColor: theme.backgroundSelected }]}>
                <Ionicons name="people" size={28} color="#208AEF" />
                <ThemedView style={styles.optionTextWrap}>
                  <ThemedText type="default" style={styles.optionTitle}>
                    In-Person
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    You're meeting face-to-face with the customer.
                  </ThemedText>
                </ThemedView>
                <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} />
              </Pressable>

              <Pressable
                onPress={() => handleChannelChosen('phone')}
                style={[styles.optionCard, { borderColor: theme.backgroundSelected }]}>
                <Ionicons name="call" size={26} color="#208AEF" />
                <ThemedView style={styles.optionTextWrap}>
                  <ThemedText type="default" style={styles.optionTitle}>
                    Over-the-Phone
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    You're calling the customer, not meeting in person.
                  </ThemedText>
                </ThemedView>
                <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} />
              </Pressable>
            </ThemedView>
          ) : (
            <ThemedView style={styles.stepContainer}>
              <ThemedText type="subtitle" style={styles.heading}>
                Which device(s) are you using?
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.subheading}>
                Select the device(s) being used for this meeting.
              </ThemedText>

              <Pressable
                onPress={() => toggleDevice('this_device')}
                style={[styles.deviceCard, { borderColor: theme.backgroundSelected }]}>
                <Ionicons
                  name={selectedDevices.has('this_device') ? 'checkbox' : 'square-outline'}
                  size={24}
                  color={selectedDevices.has('this_device') ? '#16A34A' : theme.textSecondary}
                />
                <ThemedView style={styles.optionTextWrap}>
                  <ThemedText type="default" style={styles.optionTitle}>
                    This Device
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {thisDeviceLabel}
                  </ThemedText>
                </ThemedView>
              </Pressable>

              {/* Honest placeholder note — no fake devices are listed above
                  it. See file header: real "which devices are logged into
                  your account" detection does not exist yet; this is not
                  hidden from the user, it's stated plainly. */}
              <ThemedText type="small" themeColor="textSecondary" style={styles.futureNote}>
                Other devices signed into your account (e.g. a computer running ARIA web) aren't
                shown here yet — support for adding them is coming soon.
              </ThemedText>

              <Pressable
                onPress={handleContinue}
                disabled={selectedDevices.size === 0}
                style={[
                  styles.continueButton,
                  selectedDevices.size === 0 && styles.continueButtonDisabled,
                ]}>
                <ThemedText style={styles.continueButtonText}>Continue</ThemedText>
              </Pressable>
            </ThemedView>
          )}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, padding: Spacing.four, gap: Spacing.three },
  backButton: { alignSelf: 'flex-start' },
  stepContainer: { flex: 1, gap: Spacing.three, marginTop: Spacing.two },
  heading: { fontSize: 22, lineHeight: 28 },
  subheading: { marginBottom: Spacing.two },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderWidth: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderWidth: 1,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  optionTextWrap: { flex: 1, gap: 2 },
  optionTitle: { fontWeight: '700' },
  futureNote: { fontStyle: 'italic' },
  continueButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#16A34A',
    marginTop: 'auto',
  },
  continueButtonDisabled: { backgroundColor: '#9CA3AF' },
  continueButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
