import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { listMeetings, Meeting } from '@/lib/api';

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const STATUS_STYLE: Record<Meeting['status'], { bg: string; text: string }> = {
  active: { bg: '#DCFCE7', text: '#166534' },
  completed: { bg: '#F3F4F6', text: '#4B5563' },
  cancelled: { bg: '#FEE2E2', text: '#B91C1C' },
};

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setMeetings(await listMeetings()); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load meetings.'); }
  }, []);
  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);
  async function refresh() { setRefreshing(true); await load(); setRefreshing(false); }

  const today = new Date().toDateString();
  const todayMeetings = useMemo(() => meetings.filter((m) => new Date(m.started_at).toDateString() === today), [meetings, today]);
  const recentMeetings = useMemo(() => meetings.filter((m) => new Date(m.started_at).toDateString() !== today), [meetings, today]);

  const header = (
    <>
      <View style={styles.hero}>
        <View style={styles.heroCopy}><ThemedText type="title" style={styles.logo}>ARIA</ThemedText><ThemedText style={styles.greeting}>{user ? `Hey ${user.name.split(' ')[0]} 👋` : 'Sales Helper'}</ThemedText></View>
        <View style={styles.heroActions}>
          <CircleButton icon="settings-outline" label="Settings" onPress={() => router.push('/(tabs)/profile')} />
          <CircleButton icon="chatbubbles-outline" label="Objections" onPress={() => router.push('/objections')} />
          <Pressable onPress={() => router.push('/(tabs)/profile')} style={styles.avatar}><ThemedText style={styles.avatarText}>{user?.name?.charAt(0)?.toUpperCase() || '?'}</ThemedText></Pressable>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.readyCard}>
          <ThemedText type="subtitle" style={styles.readyTitle}>Ready to work?</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.readyCopy}>Start a visit, measure a floor, or build a homeowner proposal.</ThemedText>
          <View style={styles.primaryGrid}>
            <ActionButton icon="mic" label="Record a Visit" primary onPress={() => router.push('/meeting-setup')} />
            <ActionButton icon="call" label="Call a Customer" onPress={() => router.push('/call-customer')} />
          </View>
          <View style={styles.primaryGrid}>
            <ActionButton icon="scan" label="Scan a Floor" onPress={() => router.push('/floor-scan')} />
            <ActionButton icon="document-text" label="Flooring Proposal" onPress={() => router.push('/proposal')} />
          </View>
          <Pressable style={styles.scheduleButton}><Ionicons name="calendar-outline" size={19} color="#374151" /><ThemedText style={styles.scheduleText}>Schedule Ahead</ThemedText></Pressable>
        </View>

        <SectionTitle>Today's Meetings</SectionTitle>
        {loading ? <View style={styles.center}><ActivityIndicator size="large" color="#2563EB" /></View>
          : error ? <View style={styles.emptyCard}><ThemedText style={styles.emptyIcon}>⚠️</ThemedText><ThemedText type="small" style={styles.errorText}>{error}</ThemedText><Pressable onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }} style={styles.retry}><ThemedText style={styles.retryText}>Retry</ThemedText></Pressable></View>
          : todayMeetings.length === 0 ? <View style={styles.emptyCard}><ThemedText style={styles.emptyIcon}>📋</ThemedText><ThemedText type="small" themeColor="textSecondary">No meetings yet today</ThemedText></View>
          : todayMeetings.map((m) => <MeetingCard key={m.id} meeting={m} onPress={() => router.push({ pathname: '/meetings/[id]', params: { id: m.id } })} />)}

        {recentMeetings.length > 0 && <><SectionTitle>Recent</SectionTitle>{recentMeetings.slice(0, 20).map((m) => <MeetingCard key={m.id} meeting={m} onPress={() => router.push({ pathname: '/meetings/[id]', params: { id: m.id } })} />)}</>}
      </View>
    </>
  );

  return <ThemedView style={styles.fill}><SafeAreaView style={styles.fill} edges={['top']}><FlatList data={[]} renderItem={() => null} ListHeaderComponent={header} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#fff" />} /></SafeAreaView></ThemedView>;
}
function CircleButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) { return <Pressable accessibilityLabel={label} onPress={onPress} style={styles.circle}><Ionicons name={icon} size={20} color="#fff" /></Pressable>; }
function ActionButton({ icon, label, primary, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; primary?: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={({ pressed }) => [styles.actionButton, primary ? styles.actionPrimary : styles.actionSecondary, pressed && styles.pressed]}><Ionicons name={icon} size={19} color={primary ? '#fff' : '#374151'} /><ThemedText style={[styles.actionText, primary && styles.actionPrimaryText]}>{label}</ThemedText></Pressable>; }
function SectionTitle({ children }: { children: React.ReactNode }) { return <ThemedText type="small" style={styles.sectionTitle}>{children}</ThemedText>; }
function MeetingCard({ meeting, onPress }: { meeting: Meeting; onPress: () => void }) { const badge = STATUS_STYLE[meeting.status] || STATUS_STYLE.completed; return <Pressable onPress={onPress} style={({ pressed }) => [styles.meetingCard, pressed && styles.pressed]}><View style={styles.meetingText}><ThemedText type="smallBold" numberOfLines={1}>{meeting.title || meeting.customer_name || 'No customer linked'}</ThemedText><ThemedText type="small" themeColor="textSecondary">{formatDate(meeting.started_at)}</ThemedText></View><View style={[styles.status, { backgroundColor: badge.bg }]}><ThemedText type="small" style={{ color: badge.text, textTransform: 'capitalize', fontWeight: '700' }}>{meeting.status}</ThemedText></View></Pressable>; }
const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#F3F4F6' }, hero: { backgroundColor: '#1D4ED8', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, heroCopy: { gap: 4 }, logo: { color: '#fff', fontSize: 27 }, greeting: { color: '#DBEAFE', fontSize: 16 }, heroActions: { flexDirection: 'row', gap: 8, alignItems: 'center' }, circle: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#2563EB', borderWidth: 2, borderColor: '#60A5FA', alignItems: 'center', justifyContent: 'center' }, avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#2563EB', borderWidth: 2, borderColor: '#60A5FA', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: '#fff', fontWeight: '900' },
  body: { paddingHorizontal: Spacing.three, marginTop: -8, paddingBottom: 110 }, readyCard: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.three, borderWidth: 1, borderColor: '#E5E7EB', gap: Spacing.two }, readyTitle: { fontSize: 18 }, readyCopy: { marginBottom: Spacing.one }, primaryGrid: { flexDirection: 'row', gap: Spacing.two }, actionButton: { flex: 1, minHeight: 51, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 8 }, actionPrimary: { backgroundColor: '#2563EB' }, actionSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#D1D5DB' }, actionText: { color: '#374151', fontWeight: '800', fontSize: 13 }, actionPrimaryText: { color: '#fff' }, scheduleButton: { minHeight: 50, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#D1D5DB', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, scheduleText: { fontWeight: '800', color: '#374151' },
  sectionTitle: { color: '#6B7280', fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: Spacing.four, marginBottom: Spacing.two }, center: { paddingVertical: 40 }, emptyCard: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.four, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB', gap: Spacing.two }, emptyIcon: { fontSize: 31 }, errorText: { color: '#B91C1C', textAlign: 'center' }, retry: { backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 18 }, retryText: { color: '#fff', fontWeight: '800' },
  meetingCard: { backgroundColor: '#fff', borderRadius: 16, padding: Spacing.three, borderWidth: 1, borderColor: '#E5E7EB', flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.two }, meetingText: { flex: 1, gap: 3 }, status: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }, pressed: { opacity: 0.72 },
});
