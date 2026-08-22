import { Platform } from 'react-native';

import AriaFloorScanNative, {
  FloorScanResult,
  FloorScanSupport,
} from '../../modules/aria-floor-scan';

export type { FloorScanResult, FloorScanSupport };

export const FLOOR_SCAN_AVAILABLE_IN_BUILD =
  Platform.OS === 'android' && AriaFloorScanNative != null;

export async function getFloorScanSupport(): Promise<FloorScanSupport> {
  if (Platform.OS !== 'android') {
    return { platform: 'android', arCoreSupported: false, availability: 'ANDROID_ONLY' };
  }
  if (!AriaFloorScanNative) {
    return { platform: 'android', arCoreSupported: false, availability: 'NATIVE_BUILD_REQUIRED' };
  }
  return AriaFloorScanNative.getSupportAsync();
}

export async function startFloorScan(): Promise<FloorScanResult | null> {
  if (Platform.OS !== 'android') {
    throw new Error('Floor scanning is currently available in the Android APK only.');
  }
  if (!AriaFloorScanNative) {
    throw new Error('Floor scanning requires the installed ARIA APK, not Expo Go.');
  }
  return AriaFloorScanNative.startScanAsync();
}
