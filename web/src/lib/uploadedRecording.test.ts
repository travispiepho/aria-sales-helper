// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  floatToInt16,
  isMp4RecordingFile,
  LocalRecordingPlayer,
  MonoPcm16Encoder,
  recordingDecodeError,
  startMessage,
  UploadedRecordingTransport,
  validateRecordingFile,
} from './uploadedRecording';

afterEach(() => vi.unstubAllGlobals());

class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; });
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  open() { this.readyState = WebSocket.OPEN; this.onopen?.(new Event('open')); }
}

describe('uploaded recording helpers', () => {
  it('validates local audio and audio-bearing MP4 candidates without accepting other video', () => {
    expect(validateRecordingFile(null)).toMatch(/Choose/);
    expect(validateRecordingFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toMatch(/supported audio/);
    expect(validateRecordingFile(new File(['x'], 'call.wav', { type: 'audio/wav' }))).toBeNull();
    expect(validateRecordingFile(new File(['x'], 'call.mp4', { type: 'video/mp4' }))).toBeNull();
    expect(validateRecordingFile(new File(['x'], 'CALL.MP4', { type: '' }))).toBeNull();
    expect(validateRecordingFile(new File(['x'], 'silent.webm', { type: 'video/webm' }))).toMatch(/supported audio/);
    expect(isMp4RecordingFile(new File(['x'], 'call.bin', { type: 'video/mp4' }))).toBe(true);
    expect(validateRecordingFile({ name: 'large.mp4', type: 'video/mp4', size: 250 * 1024 * 1024 + 1 } as File)).toMatch(/250 MB/);
  });

  it('provides a clear error when an MP4 has no browser-decodable audio track', () => {
    expect(recordingDecodeError(new File(['x'], 'silent.mp4', { type: 'video/mp4' })).message).toMatch(/decodable audio track.*MP4/i);
  });

  it('turns local MP4 decode failure into the visible audio-track error and closes the decoder', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    class DecodeFailingAudioContext {
      state = 'running';
      decodeAudioData = vi.fn().mockRejectedValue(new DOMException('EncodingError'));
      close = close;
    }
    vi.stubGlobal('AudioContext', DecodeFailingAudioContext);
    const file = new File(['video-only'], 'silent.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
    });

    await expect(new LocalRecordingPlayer().load(file)).rejects.toThrow(/decodable audio track.*MP4/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('creates the isolated start contract without source bytes', () => {
    expect(startMessage({ durationSeconds: 3.2 })).toEqual({
      type: 'start', encoding: 'pcm_s16le', sampleRate: 16000, channels: 1,
      playbackRate: 1, durationSeconds: 3.2,
    });
  });

  it('clips Float32 samples and converts them to signed PCM16', () => {
    expect(Array.from(floatToInt16(Float32Array.from([-2, -1, 0, 1, 2])))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });

  it('mixes stereo to mono and downsamples to 16 kHz across blocks', () => {
    const encoder = new MonoPcm16Encoder(48_000);
    const left = Float32Array.from([1, 0, 0, 1, 0, 0]);
    const right = Float32Array.from([1, 0, 0, -1, 0, 0]);
    expect(Array.from(new Int16Array(encoder.encode([left, right])))).toEqual([32767, 0]);
  });

  it('sends protocol in order, streams only binary PCM, and finalizes exactly once', async () => {
    const socket = new FakeSocket();
    const transport = new UploadedRecordingTransport('meeting-1', undefined, () => socket);
    const connecting = transport.connect(vi.fn());
    socket.open();
    await connecting;
    transport.start({ durationSeconds: 1 });
    transport.sendPcm(new ArrayBuffer(4));
    transport.pause();
    transport.resume();
    expect(transport.end()).toBe(true);
    expect(transport.end()).toBe(false);
    expect(socket.sent.map(frame => typeof frame === 'string' ? JSON.parse(frame).type : 'pcm')).toEqual([
      'start', 'pcm', 'pause', 'resume', 'end',
    ]);
    expect(socket.close).not.toHaveBeenCalled();
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'completed' }) }));
    await expect(transport.waitForCompletion()).resolves.toMatchObject({ type: 'completed' });
    transport.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a visible/retryable connection failure before start', async () => {
    const socket = new FakeSocket();
    const transport = new UploadedRecordingTransport('meeting-1', undefined, () => socket);
    const connecting = transport.connect(vi.fn());
    socket.onerror?.(new Event('error'));
    await expect(connecting).rejects.toThrow(/retry/i);
  });
});
