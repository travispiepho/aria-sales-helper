import { requireOptionalNativeModule } from 'expo';

import type { FloorScanResult, FloorScanSupport } from './AriaFloorScan.types';

type AriaFloorScanNativeModule = {
  getSupportAsync(): Promise<FloorScanSupport>;
  startScanAsync(): Promise<FloorScanResult | null>;
};

export default requireOptionalNativeModule<AriaFloorScanNativeModule>('AriaFloorScan');
