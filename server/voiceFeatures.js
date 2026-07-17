/**
 * Server-side voice feature extraction (mirrors web/src/lib/voiceFeatures.ts).
 * Operates on Float32Array PCM at 16kHz.
 */

const FRAME_SIZE = 512;
const HOP_SIZE = 256;
const SAMPLE_RATE = 16000;

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = real[i + j], uIm = imag[i + j];
        const vRe = real[i + j + len / 2] * curRe - imag[i + j + len / 2] * curIm;
        const vIm = real[i + j + len / 2] * curIm + imag[i + j + len / 2] * curRe;
        real[i + j] = uRe + vRe; imag[i + j] = uIm + vIm;
        real[i + j + len / 2] = uRe - vRe; imag[i + j + len / 2] = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe; curRe = nr;
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function extractFrameFeatures(frame) {
  const n = frame.length;
  const window = hann(n);
  const real = new Float64Array(n), imag = new Float64Array(n);
  for (let i = 0; i < n; i++) real[i] = frame[i] * window[i];
  fft(real, imag);
  const halfN = n / 2;
  const mags = new Float64Array(halfN);
  let totalMag = 0;
  for (let i = 0; i < halfN; i++) {
    mags[i] = Math.sqrt(real[i] ** 2 + imag[i] ** 2);
    totalMag += mags[i];
  }
  let centNum = 0, spreadNum = 0, cumMag = 0, rolloff = 0;
  for (let i = 0; i < halfN; i++) {
    centNum += i * mags[i];
  }
  const centroid = totalMag > 0 ? (centNum / totalMag) * (SAMPLE_RATE / n) : 0;
  for (let i = 0; i < halfN; i++) {
    spreadNum += ((i * SAMPLE_RATE / n) - centroid) ** 2 * mags[i];
  }
  const spread = totalMag > 0 ? Math.sqrt(spreadNum / totalMag) : 0;
  const thresh = 0.85 * totalMag;
  for (let i = 0; i < halfN; i++) {
    cumMag += mags[i];
    if (cumMag >= thresh) { rolloff = i * (SAMPLE_RATE / n); break; }
  }
  let zcr = 0;
  for (let i = 1; i < n; i++) if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zcr++;
  zcr /= n;
  const energy = mags.reduce((s, m) => s + m * m, 0);
  return { centroid, rolloff, zcr, energy, spread };
}

export function extractVoiceFeatures(pcm) {
  const frames = [];
  for (let start = 0; start + FRAME_SIZE <= pcm.length; start += HOP_SIZE) {
    const frame = new Float64Array(FRAME_SIZE);
    let rms = 0;
    for (let i = 0; i < FRAME_SIZE; i++) { frame[i] = pcm[start + i]; rms += frame[i] ** 2; }
    if (Math.sqrt(rms / FRAME_SIZE) < 0.01) continue;
    frames.push(extractFrameFeatures(frame));
  }
  if (frames.length === 0) return { centroid_mean: 0, centroid_std: 0, rolloff_mean: 0, rolloff_std: 0, zcr_mean: 0, zcr_std: 0, energy_mean: 0, spread_mean: 0, frame_count: 0 };
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr, m) => Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  const cs = frames.map(f => f.centroid), rs = frames.map(f => f.rolloff), zs = frames.map(f => f.zcr);
  const cm = mean(cs), rm = mean(rs), zm = mean(zs);
  return {
    centroid_mean: cm, centroid_std: std(cs, cm),
    rolloff_mean: rm, rolloff_std: std(rs, rm),
    zcr_mean: zm, zcr_std: std(zs, zm),
    energy_mean: mean(frames.map(f => f.energy)),
    spread_mean: mean(frames.map(f => f.spread)),
    frame_count: frames.length,
  };
}

export function similarityScore(a, b) {
  if (!a || !b || a.frame_count === 0 || b.frame_count === 0) return 0;
  const keys = ['centroid_mean', 'centroid_std', 'rolloff_mean', 'rolloff_std', 'zcr_mean', 'zcr_std', 'energy_mean', 'spread_mean'];
  let dist = 0;
  for (const k of keys) {
    const denom = Math.max(Math.abs(a[k]), Math.abs(b[k]), 1);
    dist += Math.abs(a[k] - b[k]) / denom;
  }
  return Math.max(0, 1 - dist / keys.length);
}
