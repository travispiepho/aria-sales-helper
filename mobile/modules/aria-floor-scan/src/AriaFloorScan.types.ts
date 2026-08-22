export type FloorScanSupport = {
  platform: 'android';
  arCoreSupported: boolean;
  availability: string;
};

export type FloorScanPoint = {
  x: number;
  y: number;
  z: number;
};

export type FloorScanResult = {
  unit: 'metric';
  areaSquareMeters: number;
  areaSquareFeet: number;
  perimeterMeters: number;
  pointCount: number;
  points: FloorScanPoint[];
  depthMode: 'automatic' | 'plane-fallback';
  capturedAt: string;
};
