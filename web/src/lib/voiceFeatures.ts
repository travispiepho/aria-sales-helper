/**
 * Voice feature extraction from raw PCM samples (Float32Array).
 * Computes spectral centroid, spectral rolloff, zero-crossing rate,
 * and energy across frames — compact enough to store in DB, distinctive enough
 * to match rep vs customer in a two-speaker scenario.
 */

const FRAME_SIZE = 512;
const HOP_SIZE = 256;
const SAMPLE_RATE = 16000;

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n <= 1) return;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  // Cooley-Tukey FFT
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = real[i + j];
        const uIm = imag[i + j];
        const vRe = real[i + j + len / 2] * curRe - imag[i + j + len / 2] * curIm;
        const vIm = real[i + j + len / 2] * curIm + imag[i + j + len / 2] * curRe;
        real[i + j] = uRe + vRe;
        imag[i + j] = uIm + vIm;
        real[i + j + len / 2] = uRe - vRe;
        imag[i + j + len / 2] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

interface FrameFeatures {
  centroid: number;
  rolloff: number;
  zcr: number;
  energy: number;
  spread: number;
}

function extractFrameFeatures(frame: Float64Array): FrameFeatures {
  const n = frame.length;
  const window = hann(n);
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  for (let i = 0; i < n; i++) real[i] = frame[i] * window[i];

  fft(real, imag);

  const halfN = n / 2;
  const magnitudes = new Float64Array(halfN);
  let totalMag = 0;
  let energy = 0;

  for (let i = 0; i < halfN; i++) {
    magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    totalMag += magnitudes[i];
    energy += magnitudes[i] * magnitudes[i];
  }

  // Spectral centroid
  let centroidNum = 0;
  for (let i = 0; i < halfN; i++) {
    centroidNum += i * magnitudes[i];
  }
  const centroid = totalMag > 0 ? (centroidNum / totalMag) * (SAMPLE_RATE / n) : 0;

  // Spectral spread
  let spreadNum = 0;
  for (let i = 0; i < halfN; i++) {
    const freq = i * (SAMPLE_RATE / n);
    spreadNum += (freq - centroid) ** 2 * magnitudes[i];
  }
  const spread = totalMag > 0 ? Math.sqrt(spreadNum / totalMag) : 0;

  // Spectral rolloff (85%)
  const rolloffThreshold = 0.85 * totalMag;
  let cumMag = 0;
  let rolloff = 0;
  for (let i = 0; i < halfN; i++) {
    cumMag += magnitudes[i];
    if (cumMag >= rolloffThreshold) {
      rolloff = i * (SAMPLE_RATE / n);
      break;
    }
  }

  // Zero-crossing rate
  let zcr = 0;
  for (let i = 1; i < n; i++) {
    if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zcr++;
  }
  zcr /= n;

  return { centroid, rolloff, zcr, energy, spread };
}

export interface VoiceFeatures {
  centroid_mean: number;
  centroid_std: number;
  rolloff_mean: number;
  rolloff_std: number;
  zcr_mean: number;
  zcr_std: number;
  energy_mean: number;
  spread_mean: number;
  frame_count: number;
}

export function extractVoiceFeatures(pcmSamples: Float32Array): VoiceFeatures {
  const frames: FrameFeatures[] = [];

  for (let start = 0; start + FRAME_SIZE <= pcmSamples.length; start += HOP_SIZE) {
    const frame = new Float64Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = pcmSamples[start + i];

    // Skip silent frames
    let rms = 0;
    for (let i = 0; i < FRAME_SIZE; i++) rms += frame[i] * frame[i];
    rms = Math.sqrt(rms / FRAME_SIZE);
    if (rms < 0.01) continue;

    frames.push(extractFrameFeatures(frame));
  }

  if (frames.length === 0) {
    return { centroid_mean: 0, centroid_std: 0, rolloff_mean: 0, rolloff_std: 0, zcr_mean: 0, zcr_std: 0, energy_mean: 0, spread_mean: 0, frame_count: 0 };
  }

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr: number[], m: number) => Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);

  const centroids = frames.map(f => f.centroid);
  const rolloffs = frames.map(f => f.rolloff);
  const zcrs = frames.map(f => f.zcr);
  const energies = frames.map(f => f.energy);
  const spreads = frames.map(f => f.spread);

  const cm = mean(centroids);
  const rm = mean(rolloffs);
  const zm = mean(zcrs);

  return {
    centroid_mean: cm,
    centroid_std: std(centroids, cm),
    rolloff_mean: rm,
    rolloff_std: std(rolloffs, rm),
    zcr_mean: zm,
    zcr_std: std(zcrs, zm),
    energy_mean: mean(energies),
    spread_mean: mean(spreads),
    frame_count: frames.length,
  };
}

export function similarityScore(a: VoiceFeatures, b: VoiceFeatures): number {
  // Normalized distance across features — lower = more similar
  // Returns 0-1 similarity (1 = identical)
  if (a.frame_count === 0 || b.frame_count === 0) return 0;

  const features: (keyof VoiceFeatures)[] = [
    'centroid_mean', 'centroid_std', 'rolloff_mean', 'rolloff_std',
    'zcr_mean', 'zcr_std', 'energy_mean', 'spread_mean',
  ];

  let distSum = 0;
  for (const f of features) {
    const va = a[f] as number;
    const vb = b[f] as number;
    const denom = Math.max(Math.abs(va), Math.abs(vb), 1);
    distSum += Math.abs(va - vb) / denom;
  }

  const avgDist = distSum / features.length;
  return Math.max(0, 1 - avgDist);
}
