// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  floatToInt16,
  MonoPcm16Encoder,
  startMessage,
  UploadedRecordingTransport,
  validateRecordingFile,
} from './uploadedRecording';

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
  it('validates local audio and never accepts a non-audio source', () => {
    expect(validateRecordingFile(null)).toMatch(/Choose/);
    expect(validateRecordingFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toMatch(/supported audio/);
    expect(validateRecordingFile(new File(['x'], 'call.wav', { type: 'audio/wav' }))).toBeNull();
  });

  it('creates the isolated start contract without source bytes', () => {
    expect(startMessage({ durationMs: 3200, fileName: 'call.wav', mimeType: 'audio/wav' })).toEqual({
      type: 'start', duration_ms: 3200, file_name: 'call.wav', mime_type: 'audio/wav',
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
    const transport = new UploadedRecordingTransport('meeting-1', () => socket);
    const connecting = transport.connect(vi.fn());
    socket.open();
    await connecting;
    transport.start({ durationMs: 1000, fileName: 'call.wav', mimeType: 'audio/wav' });
    transport.sendPcm(new ArrayBuffer(4));
    transport.pause();
    transport.resume();
    expect(transport.end()).toBe(true);
    expect(transport.end()).toBe(false);
    expect(socket.sent.map(frame => typeof frame === 'string' ? JSON.parse(frame).type : 'pcm')).toEqual([
      'start', 'pcm', 'pause', 'resume', 'end',
    ]);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a visible/retryable connection failure before start', async () => {
    const socket = new FakeSocket();
    const transport = new UploadedRecordingTransport('meeting-1', () => socket);
    const connecting = transport.connect(vi.fn());
    socket.onerror?.(new Event('error'));
    await expect(connecting).rejects.toThrow(/retry/i);
  });
});
