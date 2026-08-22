import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  FloorScanResult,
  FloorScanSupport,
  getFloorScanSupport,
  startFloorScan,
} from '@/lib/floorScan';

export default function FloorScanScreen() {
  const router = useRouter();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [support, setSupport] = useState<FloorScanSupport | null>(null);
  const [checking, setChecking] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<FloorScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFloorScanSupport()
      .then(setSupport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to check ARCore support.'))
      .finally(() => setChecking(false));
  }, []);

  async function handleScan() {
    setError(null);
    setScanning(true);
    try {
      const next = await startFloorScan();
      if (next) setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Floor scan failed.');
    } finally {
      setScanning(false);
    }
  }

  function handleUseMeasurement() {
    if (!result) return;
    if (returnTo === 'proposal') {
      router.replace({ pathname: '/proposal', params: { scannedSqFt: result.areaSquareFeet.toFixed(1) } });
      return;
    }
    router.back();
  }

  const supported = support?.arCoreSupported === true;

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ThemedView style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color="#DBEAFE" />
          </Pressable>
          <View style={styles.headerText}>
            <ThemedText type="title" style={styles.headerTitle}>Floor Scan</ThemedText>
            <ThemedText type="small" style={styles.headerSubtitle}>Freedom Flooring measurement</ThemedText>
          </View>
        </ThemedView>

        <ThemedView style={styles.content}>
          <ThemedView style={styles.card} type="backgroundElement">
            <View style={styles.iconCircle}><Ionicons name="scan" size={34} color="#2563EB" /></View>
            <ThemedText type="subtitle" style={styles.cardTitle}>Measure the room perimeter</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.bodyText}>
              Walk the room and tap each floor corner. ARIA uses Android ARCore Depth when the device supports it, with plane tracking as a fallback.
            </ThemedText>

            {checking ? (
              <View style={styles.statusRow}><ActivityIndicator /><ThemedText type="small">Checking this device…</ThemedText></View>
            ) : (
              <View style={[styles.supportPill, supported ? styles.supported : styles.unsupported]}>
                <Ionicons name={supported ? 'checkmark-circle' : 'alert-circle'} size={18} color={supported ? '#15803D' : '#B45309'} />
                <ThemedText type="small" style={supported ? styles.supportedText : styles.unsupportedText}>
                  {supported ? 'ARCore supported on this device' : support?.availability === 'NATIVE_BUILD_REQUIRED' ? 'Install the APK to use native scanning' : 'ARCore is not available on this device'}
                </ThemedText>
              </View>
            )}

            <View style={styles.steps}>
              <Step number="1" text="Stand where the whole floor edge is visible." />
              <Step number="2" text="Move slowly so ARCore can map the room." />
              <Step number="3" text="Tap every corner in order, then finish the room." />
            </View>

            <Pressable
              onPress={handleScan}
              disabled={!supported || scanning}
              style={({ pressed }) => [styles.primaryButton, (!supported || scanning) && styles.buttonDisabled, pressed && styles.pressed]}>
              {scanning ? <ActivityIndicator color="#fff" /> : <><Ionicons name="camera" size={20} color="#fff" /><ThemedText style={styles.primaryButtonText}>{result ? 'Scan Again' : 'Start Floor Scan'}</ThemedText></>}
            </Pressable>
            <ThemedText type="small" themeColor="textSecondary" style={styles.disclaimer}>
              Measurements are estimates and should be verified before final material ordering or a binding proposal.
            </ThemedText>
          </ThemedView>

          {error && <ThemedView style={styles.errorCard}><ThemedText type="small" style={styles.errorText}>{error}</ThemedText></ThemedView>}

          {result && (
            <ThemedView style={styles.resultCard} type="backgroundElement">
              <ThemedText type="small" style={styles.resultEyebrow}>ROOM MEASUREMENT</ThemedText>
              <ThemedText style={styles.sqft}>{result.areaSquareFeet.toFixed(1)} sq ft</ThemedText>
              <View style={styles.metricRow}>
                <Metric label="Perimeter" value={`${(result.perimeterMeters * 3.28084).toFixed(1)} ft`} />
                <Metric label="Corners" value={`${result.pointCount}`} />
                <Metric label="Depth" value={result.depthMode === 'automatic' ? 'ARCore' : 'Plane'} />
              </View>
              <Pressable onPress={handleUseMeasurement} style={({ pressed }) => [styles.useButton, pressed && styles.pressed]}>
                <ThemedText style={styles.useButtonText}>{returnTo === 'proposal' ? 'Use in Flooring Proposal' : 'Done'}</ThemedText>
              </Pressable>
            </ThemedView>
          )}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

function Step({ number, text }: { number: string; text: string }) {
  return <View style={styles.step}><View style={styles.stepNumber}><ThemedText style={styles.stepNumberText}>{number}</ThemedText></View><ThemedText type="small" style={styles.stepText}>{text}</ThemedText></View>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metric}><ThemedText type="small" themeColor="textSecondary">{label}</ThemedText><ThemedText type="smallBold">{value}</ThemedText></View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#F3F4F6' },
  header: { backgroundColor: '#1D4ED8', paddingHorizontal: Spacing.four, paddingVertical: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  backButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1 }, headerTitle: { color: '#fff', fontSize: 25 }, headerSubtitle: { color: '#DBEAFE', marginTop: 2 },
  content: { flex: 1, backgroundColor: '#F3F4F6', padding: Spacing.three, gap: Spacing.three },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.four, alignItems: 'center', gap: Spacing.two, borderWidth: 1, borderColor: '#E5E7EB' },
  iconCircle: { width: 66, height: 66, borderRadius: 18, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 20, textAlign: 'center' }, bodyText: { textAlign: 'center', lineHeight: 20 },
  statusRow: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center', paddingVertical: Spacing.two },
  supportPill: { width: '100%', borderRadius: 12, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two, borderWidth: 1 },
  supported: { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' }, unsupported: { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' },
  supportedText: { color: '#15803D', fontWeight: '700' }, unsupportedText: { color: '#92400E', fontWeight: '700' },
  steps: { width: '100%', gap: Spacing.two, marginVertical: Spacing.two }, step: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  stepNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#DBEAFE', alignItems: 'center', justifyContent: 'center' }, stepNumberText: { color: '#1D4ED8', fontWeight: '800' }, stepText: { flex: 1 },
  primaryButton: { width: '100%', minHeight: 52, borderRadius: 12, backgroundColor: '#2563EB', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  primaryButtonText: { color: '#fff', fontWeight: '800', fontSize: 16 }, buttonDisabled: { opacity: 0.45 }, pressed: { opacity: 0.78 }, disclaimer: { textAlign: 'center', fontSize: 12, lineHeight: 17 },
  errorCard: { backgroundColor: '#FEF2F2', borderRadius: 12, padding: Spacing.three, borderWidth: 1, borderColor: '#FECACA' }, errorText: { color: '#B91C1C', textAlign: 'center' },
  resultCard: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.four, alignItems: 'center', gap: Spacing.three, borderWidth: 1, borderColor: '#D1FAE5' },
  resultEyebrow: { color: '#047857', fontWeight: '800', letterSpacing: 0.8 }, sqft: { fontSize: 32, fontWeight: '900', color: '#065F46' },
  metricRow: { width: '100%', flexDirection: 'row', justifyContent: 'space-between' }, metric: { alignItems: 'center', gap: 3, flex: 1 },
  useButton: { width: '100%', backgroundColor: '#16A34A', borderRadius: 12, paddingVertical: Spacing.three, alignItems: 'center' }, useButtonText: { color: '#fff', fontWeight: '800' },
});
