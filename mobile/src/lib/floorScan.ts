import { Platform } from 'react-native';

import type { FloorScanResult, FloorScanSupport } from '../../modules/aria-floor-scan';
import { IS_DEMO_MODE } from '@/lib/demo';

export type { FloorScanResult, FloorScanSupport };

type NativeFloorScanModule = {
  getSupportAsync(): Promise<FloorScanSupport>;
  startScanAsync(): Promise<FloorScanResult | null>;
};

// Do not load any custom native code during the app's root/router bootstrap.
// Expo Router discovers every route at startup, including /floor-scan. A
// scanner integration problem must disable only that feature—not prevent the
// login screen from replacing the native splash.
function getNativeFloorScan(): NativeFloorScanModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    return require('../../modules/aria-floor-scan').default as NativeFloorScanModule | null;
  } catch {
    return null;
  }
}

export function isFloorScanAvailableInBuild(): boolean {
  return getNativeFloorScan() != null;
}

export async function getFloorScanSupport(): Promise<FloorScanSupport> {
  if (IS_DEMO_MODE) {
    return { platform: 'android', arCoreSupported: false, availability: 'DISABLED_IN_DEMO' };
  }
  if (Platform.OS !== 'android') {
    return { platform: 'android', arCoreSupported: false, availability: 'ANDROID_ONLY' };
  }
  const nativeModule = getNativeFloorScan();
  if (!nativeModule) {
    return { platform: 'android', arCoreSupported: false, availability: 'NATIVE_BUILD_REQUIRED' };
  }
  return nativeModule.getSupportAsync();
}

export async function startFloorScan(): Promise<FloorScanResult | null> {
  if (IS_DEMO_MODE) {
    throw new Error('Floor scanning is disabled in ARIA TEST. No camera or customer measurements are captured.');
  }
  if (Platform.OS !== 'android') {
    throw new Error('Floor scanning is currently available in the Android APK only.');
  }
  const nativeModule = getNativeFloorScan();
  if (!nativeModule) {
    throw new Error('Floor scanning requires the installed ARIA APK, not Expo Go.');
  }
  return nativeModule.startScanAsync();
}
