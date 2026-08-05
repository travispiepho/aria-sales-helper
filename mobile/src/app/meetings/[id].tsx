/**
 * meetings/[id].tsx — Meeting detail / transcript viewer.
 *
 * Reached by tapping a row in the Home tab's history list
 * ((tabs)/index.tsx). Fetches the full meeting record (GET
 * /api/meetings/:id) plus its saved transcript segments (GET
 * /api/meetings/:id/segments) — both EXISTING backend endpoints already
 * used by the web PWA (see app/web/src/pages/HomePage.tsx's handleDownload()
 * for the reference data shape: title/customer_name/started_at/summary +
 * speaker/text segments).
 *
 * This is a read-only transcript viewer, PLUS (2026-08-04 save-parity fix)
 * a "Generate Summary" action mirroring web's MeetingPage.tsx
 * handleGenerateSummary() — web does NOT auto-generate a summary when a
 * meeting ends either; it's a manual, rep-initiated button tap that calls
 * the existing POST /api/meetings/:id/summary endpoint. Mobile previously
 * had no UI path to reach that endpoint at all (verified via a live
 * mobile-sequence test against production: transcript_segments persisted
 * correctly, summary stayed null forever with no way to trigger it) — this
 * closes that gap with the minimal, exact match to web's existing behavior.
 * Download/export/delete actions remain web-only for now (out of scope).
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { generateSummary, getMeeting, getMeetingSegments, Meeting, TranscriptSegment } from '@/lib/api';

export default function MeetingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      try {
        const [m, segRes] = await Promise.all([getMeeting(id), getMeetingSegments(id)]);
        setMeeting(m);
        setSegments(segRes.segments);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load meeting.');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function handleGenerateSummary() {
    if (!id) return;
    setSummaryLoading(true);
    try {
      const { summary } = await generateSummary(id);
      setMeeting((prev) => (prev ? { ...prev, summary } : prev));
    } catch (err) {
      Alert.alert('Summary failed', err instanceof Error ? err.message : 'Failed to generate summary.');
    } finally {
      setSummaryLoading(false);
    }
  }

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ThemedView style={styles.container}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <ThemedText type="link">← Back</ThemedText>
          </Pressable>

          {loading ? (
            <ThemedView style={styles.centerFill}>
              <ActivityIndicator size="large" />
            </ThemedView>
          ) : error ? (
            <ThemedView style={styles.centerFill}>
              <ThemedText type="small" style={styles.errorText}>
                {error}
              </ThemedText>
            </ThemedView>
          ) : meeting ? (
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <ThemedText type="title" style={styles.title}>
                {meeting.title || meeting.customer_name || 'Meeting'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {new Date(meeting.started_at).toLocaleString([], {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </ThemedText>
              {meeting.customer_name && (
                <ThemedText type="small" themeColor="textSecondary">
                  Customer: {meeting.customer_name}
                </ThemedText>
              )}

              <ThemedView style={styles.card} type="backgroundElement">
                <ThemedText type="smallBold" style={styles.cardLabel}>
                  SUMMARY
                </ThemedText>
                {meeting.summary ? (
                  <ThemedText type="small">{meeting.summary}</ThemedText>
                ) : (
                  <>
                    <ThemedText type="small" themeColor="textSecondary">
                      No summary generated yet.
                    </ThemedText>
                    <Pressable
                      onPress={handleGenerateSummary}
                      disabled={summaryLoading || segments.length === 0}
                      style={[styles.generateButton, (summaryLoading || segments.length === 0) && styles.generateButtonDisabled]}>
                      {summaryLoading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <ThemedText style={styles.generateButtonText}>✨ Generate Summary</ThemedText>
                      )}
                    </Pressable>
                    {segments.length === 0 && (
                      <ThemedText type="small" themeColor="textSecondary" style={styles.noTranscriptNote}>
                        No transcript to summarize.
                      </ThemedText>
                    )}
                  </>
                )}
              </ThemedView>

              <ThemedView style={styles.card} type="backgroundElement">
                <ThemedText type="smallBold" style={styles.cardLabel}>
                  TRANSCRIPT
                </ThemedText>
                {segments.length === 0 ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    No transcript recorded.
                  </ThemedText>
                ) : (
                  segments.map((seg, i) => (
                    <ThemedText key={`${seg.ts}-${i}`} type="small" style={styles.segmentLine}>
                      <ThemedText type="smallBold">
                        {(meeting.speaker_labels?.[seg.speaker] || seg.speaker)}:{' '}
                      </ThemedText>
                      {seg.text}
                    </ThemedText>
                  ))
                )}
              </ThemedView>
            </ScrollView>
          ) : null}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, padding: Spacing.four, gap: Spacing.three },
  backButton: { alignSelf: 'flex-start' },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { gap: Spacing.two, paddingBottom: Spacing.six },
  title: { fontSize: 24, lineHeight: 30 },
  card: { borderRadius: Spacing.three, padding: Spacing.three, marginTop: Spacing.three, gap: Spacing.two },
  cardLabel: { letterSpacing: 0.5, marginBottom: Spacing.one },
  segmentLine: { marginBottom: Spacing.two },
  errorText: { color: '#DC2626', textAlign: 'center' },
  generateButton: {
    backgroundColor: '#2563EB',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  generateButtonDisabled: { opacity: 0.5 },
  generateButtonText: { color: '#fff', fontWeight: '700' },
  noTranscriptNote: { textAlign: 'center', marginTop: Spacing.two },
});
