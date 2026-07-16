/**
 * audio-processor.js — AudioWorklet processor
 * Runs in the audio rendering thread. Captures Float32 samples,
 * downsamples to 16 kHz linear16 PCM, and posts Int16Array chunks
 * back to the main thread.
 *
 * Must be served as a static file (not bundled by Vite).
 * Loaded via: new URL('/audio-processor.js', location.origin)
 */

const TARGET_SAMPLE_RATE = 16000;

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._inputSampleRate = sampleRate; // global AudioWorkletGlobalScope sampleRate
    this._ratio = this._inputSampleRate / TARGET_SAMPLE_RATE;
    this._buffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array, one channel

    // Simple decimation: pick every Nth sample to downsample
    const step = this._ratio;
    for (let i = 0; i < samples.length; i += step) {
      const idx = Math.floor(i);
      this._buffer.push(samples[idx]);
    }

    // Emit in 1024-sample chunks
    while (this._buffer.length >= 1024) {
      const chunk = this._buffer.splice(0, 1024);
      // Convert Float32 → Int16
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
