import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

type Material = 'lvp' | 'carpet' | 'waterproof' | 'laminate' | 'hardwood' | 'tile';
const MATERIALS: { id: Material; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'lvp', label: 'Luxury Vinyl Plank', icon: 'layers-outline' },
  { id: 'carpet', label: 'Carpet', icon: 'grid-outline' },
  { id: 'waterproof', label: 'Waterproof Flooring', icon: 'water-outline' },
  { id: 'laminate', label: 'Laminate', icon: 'copy-outline' },
  { id: 'hardwood', label: 'Hardwood', icon: 'leaf-outline' },
  { id: 'tile', label: 'Tile', icon: 'apps-outline' },
];

export default function ProposalScreen() {
  const router = useRouter();
  const { scannedSqFt } = useLocalSearchParams<{ scannedSqFt?: string }>();
  const [address, setAddress] = useState('');
  const [rooms, setRooms] = useState('');
  const [sqft, setSqft] = useState(scannedSqFt || '');
  const [material, setMaterial] = useState<Material | null>(null);

  useEffect(() => { if (scannedSqFt) setSqft(scannedSqFt); }, [scannedSqFt]);

  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <View style={styles.banner}><ThemedText style={styles.bannerText}>INTERNAL BUILD · HUMAN REVIEW REQUIRED</ThemedText></View>
        <ThemedView style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerButton}><Ionicons name="arrow-back" size={22} color="#fff" /></Pressable>
          <View style={styles.headerCopy}><ThemedText type="title" style={styles.headerTitle}>One-Stop Proposal</ThemedText><ThemedText type="small" style={styles.headerSubtitle}>Freedom Flooring & Design</ThemedText></View>
        </ThemedView>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <ThemedView style={styles.card}>
            <ThemedText type="small" style={styles.eyebrow}>STEP 1 · CAPTURE</ThemedText>
            <ThemedText type="subtitle" style={styles.title}>Tell ARIA about the space</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.copy}>Enter the project details or scan the room to calculate square footage.</ThemedText>

            <Label>Property address</Label>
            <TextInput value={address} onChangeText={setAddress} placeholder="123 Lakeshore Dr, Grand Haven, MI" style={styles.input} />
            <Label>Room(s)</Label>
            <TextInput value={rooms} onChangeText={setRooms} placeholder="Living room + hallway" style={styles.input} />

            <View style={styles.measureHeader}><Label>Square footage</Label>{sqft ? <ThemedText type="small" style={styles.measured}>✓ Measured</ThemedText> : null}</View>
            <View style={styles.measureRow}>
              <TextInput value={sqft} onChangeText={setSqft} placeholder="350" keyboardType="decimal-pad" style={[styles.input, styles.sqftInput]} />
              <Pressable onPress={() => router.push({ pathname: '/floor-scan', params: { returnTo: 'proposal' } })} style={({ pressed }) => [styles.scanButton, pressed && styles.pressed]}>
                <Ionicons name="scan" size={20} color="#2563EB" /><ThemedText style={styles.scanText}>Scan Floor</ThemedText>
              </Pressable>
            </View>

            <Label>Material interest</Label>
            <View style={styles.materialGrid}>
              {MATERIALS.map((item) => {
                const selected = material === item.id;
                return <Pressable key={item.id} onPress={() => setMaterial(item.id)} style={({ pressed }) => [styles.material, selected && styles.materialSelected, pressed && styles.pressed]}>
                  <Ionicons name={item.icon} size={23} color={selected ? '#1D4ED8' : '#64748B'} />
                  <ThemedText type="small" style={[styles.materialText, selected && styles.materialTextSelected]}>{item.label}</ThemedText>
                </Pressable>;
              })}
            </View>
          </ThemedView>

          <ThemedView style={styles.flowCard}>
            <ThemedText type="small" style={styles.eyebrow}>THE ONE-STOP FLOW</ThemedText>
            <Flow icon="scan" title="Measure" text="ARCore depth scan or verified manual dimensions" />
            <Flow icon="images-outline" title="Visualize" text="Roomvo product visualization once the embed is supplied" />
            <Flow icon="layers-outline" title="Select" text="Match measured quantity to Freedom Flooring SKUs" />
            <Flow icon="document-text-outline" title="Review proposal" text="Human-reviewed estimate and installation timing" />
            <Flow icon="person-outline" title="Nolan follow-up" text="Dispatch the qualified project for final review" />
          </ThemedView>

          <Pressable disabled={!address.trim() || !rooms.trim() || !sqft.trim() || !material} style={[styles.continueButton, (!address.trim() || !rooms.trim() || !sqft.trim() || !material) && styles.disabled]}>
            <ThemedText style={styles.continueText}>Continue to Visualization</ThemedText><Ionicons name="arrow-forward" size={20} color="#fff" />
          </Pressable>
          <ThemedText type="small" themeColor="textSecondary" style={styles.footerNote}>Roomvo, the live SKU catalog, final pricing, e-sign, and automatic handoff remain gated on the source access and business inputs described in the project handoff. This screen does not quote or commit a customer.</ThemedText>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}
function Label({ children }: { children: React.ReactNode }) { return <ThemedText type="smallBold" style={styles.label}>{children}</ThemedText>; }
function Flow({ icon, title, text }: { icon: keyof typeof Ionicons.glyphMap; title: string; text: string }) { return <View style={styles.flowRow}><View style={styles.flowIcon}><Ionicons name={icon} size={20} color="#2563EB" /></View><View style={styles.flowCopy}><ThemedText type="smallBold">{title}</ThemedText><ThemedText type="small" themeColor="textSecondary">{text}</ThemedText></View></View>; }
const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#F3F4F6' }, banner: { backgroundColor: '#9A3412', paddingVertical: 7, paddingHorizontal: 12, alignItems: 'center' }, bannerText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  header: { backgroundColor: '#0B3D62', flexDirection: 'row', alignItems: 'center', padding: Spacing.three, gap: Spacing.three }, headerButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#164E73', alignItems: 'center', justifyContent: 'center' }, headerCopy: { flex: 1 }, headerTitle: { color: '#fff', fontSize: 23 }, headerSubtitle: { color: '#CBE4F4', marginTop: 2 },
  scroll: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.six }, card: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.four, borderWidth: 1, borderColor: '#E5E7EB' },
  eyebrow: { color: '#2563EB', fontWeight: '900', letterSpacing: 0.8, marginBottom: Spacing.one }, title: { fontSize: 20 }, copy: { marginTop: Spacing.one, lineHeight: 20, marginBottom: Spacing.two }, label: { marginTop: Spacing.three, marginBottom: Spacing.one, color: '#475569' }, input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, minHeight: 50, paddingHorizontal: Spacing.three, fontSize: 15, color: '#111827' },
  measureHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }, measured: { color: '#15803D', fontWeight: '800', marginBottom: Spacing.one }, measureRow: { flexDirection: 'row', gap: Spacing.two }, sqftInput: { flex: 1 }, scanButton: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: '#93C5FD', backgroundColor: '#EFF6FF', paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two }, scanText: { color: '#1D4ED8', fontWeight: '800' },
  materialGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two }, material: { width: '48%', minHeight: 82, borderRadius: 12, borderWidth: 1, borderColor: '#CBD5E1', padding: Spacing.two, alignItems: 'center', justifyContent: 'center', gap: 5 }, materialSelected: { borderWidth: 2, borderColor: '#3B82F6', backgroundColor: '#EFF6FF' }, materialText: { textAlign: 'center', color: '#475569' }, materialTextSelected: { color: '#1D4ED8', fontWeight: '800' }, pressed: { opacity: 0.75 },
  flowCard: { backgroundColor: '#fff', borderRadius: 18, padding: Spacing.four, borderWidth: 1, borderColor: '#E5E7EB', gap: Spacing.three }, flowRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three }, flowIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' }, flowCopy: { flex: 1, gap: 2 },
  continueButton: { minHeight: 54, borderRadius: 12, backgroundColor: '#1F8EF1', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two }, continueText: { color: '#fff', fontWeight: '900', fontSize: 16 }, disabled: { opacity: 0.4 }, footerNote: { textAlign: 'center', fontSize: 12, lineHeight: 17, paddingHorizontal: Spacing.two },
});
