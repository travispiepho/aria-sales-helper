/**
 * (tabs)/index.tsx — Home tab: previous meetings / transcript history.
 *
 * Per Troy's bottom-nav requirement: "Home button's destination must show
 * PREVIOUS TRANSCRIPTS" — i.e. tapping Home shows a list of the user's past
 * meetings (title/date/customer), and tapping into one shows that meeting's
 * transcript/summary (see ../meetings/[id].tsx).
 *
 * Ported/adapted from app/web/src/pages/HomePage.tsx's meetings-list view
 * (read as the reference UI/data pattern per the task instructions) — same
 * EXISTING backend contract, GET /api/meetings (see src/lib/api.ts's
 * listMeetings(), which now exists on mobile mirroring the web client).
 * Simplified for this navigation-restructure pass: no download/delete
 * actions (out of scope — this is a history *viewer*, not the full web
 * meeting-management surface); those remain web-only for now.
 *
 * The old index.tsx's post-login "Start In-Person Meeting" button dashboard
 * is superseded by the new center Record tab (see (tabs)/_layout.tsx) — this
 * screen is now purely the meeting history / previous-transcripts view, as
 * specified.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { listMeetings, Meeting } from '@/lib/api';

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_COLOR: Record<Meeting['status'], string> = {
  active: '#16A34A',
  completed: '#6B7280',
  cancelled: '#DC2626',
};

export default function HistoryScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { user } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listMeetings();
      setMeetings(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load meetings.');
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={['top']}>
        <ThemedView style={styles.header}>
          <ThemedText type="title" style={styles.headerTitle}>
            ARIA
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {user ? `Hey ${user.name.split(' ')[0]} 👋` : 'Previous transcripts'}
          </ThemedText>
        </ThemedView>

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
        ) : meetings.length === 0 ? (
          <ThemedView style={styles.centerFill}>
            <ThemedText style={styles.emptyIcon}>📋</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              No meetings yet — tap Record to start one.
            </ThemedText>
          </ThemedView>
        ) : (
          <FlatList
            data={meetings}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => router.push({ pathname: '/meetings/[id]', params: { id: item.id } })}
                style={({ pressed }) => [
                  styles.card,
                  { borderColor: theme.backgroundSelected, backgroundColor: theme.backgroundElement },
                  pressed && styles.cardPressed,
                ]}>
                <ThemedView style={styles.cardRow} type="backgroundElement">
                  <ThemedView style={styles.cardTextCol} type="backgroundElement">
                    <ThemedText type="smallBold" numberOfLines={1}>
                      {item.title || item.customer_name || 'No customer linked'}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {formatDate(item.started_at)}
                    </ThemedText>
                  </ThemedView>
                  <ThemedView
                    style={[styles.statusPill, { backgroundColor: STATUS_COLOR[item.status] }]}
                    type="backgroundElement">
                    <ThemedText type="small" style={styles.statusPillText}>
                      {item.status}
                    </ThemedText>
                  </ThemedView>
                </ThemedView>
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.four },
  header: { paddingHorizontal: Spacing.four, paddingTop: Spacing.two, paddingBottom: Spacing.three, gap: Spacing.half },
  headerTitle: { fontSize: 28, lineHeight: 34 },
  listContent: { paddingHorizontal: Spacing.four, paddingBottom: Spacing.six, gap: Spacing.two },
  card: { borderWidth: 1, borderRadius: Spacing.three, padding: Spacing.three, marginBottom: Spacing.two },
  cardPressed: { opacity: 0.7 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  cardTextCol: { flex: 1, gap: 2 },
  statusPill: { paddingHorizontal: Spacing.two, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { color: '#fff', fontWeight: '700', textTransform: 'capitalize' },
  emptyIcon: { fontSize: 32 },
  errorText: { color: '#DC2626', textAlign: 'center' },
});
