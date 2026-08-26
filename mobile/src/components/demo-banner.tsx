import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IS_DEMO_MODE } from '@/lib/demo';

export function DemoBanner() {
  if (!IS_DEMO_MODE) return null;
  return (
    <View accessibilityRole="alert" style={styles.banner}>
      <ThemedText style={styles.title}>ARIA TEST · OFFLINE DEMO</ThemedText>
      <ThemedText style={styles.copy}>No login · no production access · changes disabled</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#7F1D1D',
    borderBottomColor: '#FCA5A5',
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: 'center',
  },
  title: { color: '#fff', fontSize: 13, lineHeight: 17, fontWeight: '900', letterSpacing: 0.5 },
  copy: { color: '#FEE2E2', fontSize: 11, lineHeight: 14, fontWeight: '600' },
});
