import { getWsBase } from './wsBase';

/**
 * Uploaded-recording backend contract. Keep every route, channel and wire
 * message in this module so the web and server implementations can be
 * reconciled without hunting through UI code.
 */
export const UPLOADED_RECORDING_CONTRACT = {
  meetingChannel: 'uploaded_recording' as const,
  websocketPath: (meetingId: string) => `/meetings/${meetingId}/uploaded-recording`,
  messageTypes: {
    start: 'start',
    started: 'started',
    pause: 'pause',
    resume: 'resume',
    end: 'end',
  },
} as const;

export const TARGET_PCM_SAMPLE_RATE = 16_000;
export const PLAYBACK_RATE = 1;
export const UPLOADED_RECORDING_ACCEPT = 'audio/*,video/mp4,.mp4';

export function isMp4RecordingFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.toLowerCase() === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');
}

export function recordingDecodeError(file: Pick<File, 'name' | 'type'>): Error {
  if (isMp4RecordingFile(file)) {
    return new Error('ARIA could not find a decodable audio track in this MP4 file. Choose an MP4 with audio and retry.');
  }
  return new Error('ARIA could not decode this audio file. Choose another file and retry.');
}

export interface RecordingMetadata {
  durationSeconds: number;
}

export function uploadedRecordingWsUrl(meetingId: string, serverPath?: string): string {
  return `${getWsBase()}${serverPath || UPLOADED_RECORDING_CONTRACT.websocketPath(meetingId)}`;
}

export function startMessage(metadata: RecordingMetadata) {
  return {
    type: UPLOADED_RECORDING_CONTRACT.messageTypes.start,
    encoding: 'pcm_s16le',
    sampleRate: TARGET_PCM_SAMPLE_RATE,
    channels: 1,
    playbackRate: PLAYBACK_RATE,
    durationSeconds: metadata.durationSeconds,
  };
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  }
  return pcm;
}

/** Stateful mono/downsampling converter suitable for successive Web Audio blocks. */
export class MonoPcm16Encoder {
  private readonly ratio: number;
  private position = 0;

  constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate = TARGET_PCM_SAMPLE_RATE,
  ) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0 || outputSampleRate > inputSampleRate) {
      throw new Error('Unsupported audio sample rate');
    }
    this.ratio = inputSampleRate / outputSampleRate;
  }

  encode(channels: Float32Array[]): ArrayBuffer {
    if (channels.length === 0 || channels[0].length === 0) return new ArrayBuffer(0);
    const length = Math.min(...channels.map(channel => channel.length));
    const output: number[] = [];

    while (this.position < length) {
      const index = Math.floor(this.position);
      let mono = 0;
      for (const channel of channels) mono += channel[index] || 0;
      output.push(mono / channels.length);
      this.position += this.ratio;
    }
    this.position -= length;
    const pcm = floatToInt16(Float32Array.from(output));
    return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
  }
}

interface SocketLike {
  readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string) => SocketLike;

/** Owns the authenticated recording-playback socket and enforces one end frame. */
export class UploadedRecordingTransport {
  private socket: SocketLike | null = null;
  private ended = false;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private completion: unknown | null = null;
  private completionError: Error | null = null;
  private completionWaiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];

  constructor(
    private readonly meetingId: string,
    private readonly serverPath?: string,
    private readonly socketFactory: SocketFactory = url => new WebSocket(url),
  ) {}

  async connect(onMessage: (message: unknown) => void): Promise<void> {
    if (this.socket) throw new Error('Playback connection already created');
    const socket = this.socketFactory(uploadedRecordingWsUrl(this.meetingId, this.serverPath));
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data);
        if (message?.type === UPLOADED_RECORDING_CONTRACT.messageTypes.started) {
          this.started = true;
          this.resolveStart?.();
        } else if (message?.type === 'error' && !this.started) {
          this.rejectStart?.(new Error(typeof message.error === 'string' ? message.error : 'ARIA rejected the recording metadata.'));
        } else if (message?.type === 'completed') {
          this.completion = message;
          for (const waiter of this.completionWaiters.splice(0)) waiter.resolve(message);
        }
        onMessage(message);
      } catch { /* ignore malformed server frames */ }
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.onopen = () => { settled = true; resolve(); };
      socket.onerror = () => {
        const error = new Error('Could not connect to ARIA. Check your connection and retry.');
        if (!settled) reject(error);
        if (!this.started) this.rejectStart?.(error);
      };
      socket.onclose = () => {
        const error = new Error('ARIA closed the connection before analysis completed. Retry.');
        if (!settled) reject(error);
        if (!this.started) this.rejectStart?.(error);
        if (!this.completion) {
          this.completionError = error;
          for (const waiter of this.completionWaiters.splice(0)) waiter.reject(error);
        }
      };
    });
  }

  start(metadata: RecordingMetadata, timeoutMs = 10_000): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ARIA did not acknowledge the recording metadata. Retry.')), timeoutMs);
      this.resolveStart = () => { clearTimeout(timer); resolve(); };
      this.rejectStart = error => { clearTimeout(timer); reject(error); };
      try {
        this.sendJson(startMessage(metadata));
      } catch (error) {
        this.rejectStart(error instanceof Error ? error : new Error('Could not start ARIA playback.'));
      }
    });
    return this.startPromise;
  }

  sendPcm(buffer: ArrayBuffer): void {
    if (!this.started || this.ended || buffer.byteLength === 0 || !this.isOpen()) return;
    this.socket!.send(buffer);
  }

  pause(): void { if (!this.ended) this.sendJson({ type: UPLOADED_RECORDING_CONTRACT.messageTypes.pause }); }
  resume(): void { if (!this.ended) this.sendJson({ type: UPLOADED_RECORDING_CONTRACT.messageTypes.resume }); }

  end(): boolean {
    if (this.ended) return false;
    this.ended = true;
    if (this.isOpen()) this.socket!.send(JSON.stringify({ type: UPLOADED_RECORDING_CONTRACT.messageTypes.end }));
    return true;
  }

  waitForCompletion(timeoutMs = 60_000): Promise<unknown> {
    if (this.completion) return Promise.resolve(this.completion);
    if (this.completionError) return Promise.reject(this.completionError);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      this.completionWaiters.push(waiter);
      timer = setTimeout(() => {
        const index = this.completionWaiters.indexOf(waiter);
        if (index >= 0) this.completionWaiters.splice(index, 1);
        reject(new Error('ARIA is still finalizing this recording. Open the meeting from History in a moment.'));
      }, timeoutMs);
    });
  }

  close(): void {
    if (!this.started) this.rejectStart?.(new Error('ARIA playback was closed before recording metadata was acknowledged.'));
    this.socket?.close(1000, 'cleanup');
    this.socket = null;
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private sendJson(message: object): void {
    if (!this.isOpen()) throw new Error('ARIA playback connection is not open');
    this.socket!.send(JSON.stringify(message));
  }
}

export interface PlaybackCallbacks {
  onPcm: (buffer: ArrayBuffer) => void;
  onProgress: (seconds: number) => void;
  onEnded: () => void;
}

/**
 * Local-only decoder/player. The source bytes never leave this class; only
 * real-time mono 16-kHz PCM blocks emitted by Web Audio reach the caller.
 */
export class LocalRecordingPlayer {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private encoder: MonoPcm16Encoder | null = null;
  private callbacks: PlaybackCallbacks | null = null;
  private offsetSeconds = 0;
  private startedAt = 0;
  private sourceGeneration = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  get durationSeconds(): number { return this.buffer?.duration ?? 0; }
  get currentSeconds(): number {
    if (!this.context || !this.source) return this.offsetSeconds;
    return Math.min(this.durationSeconds, this.offsetSeconds + (this.context.currentTime - this.startedAt));
  }

  async load(file: File): Promise<void> {
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('This browser cannot decode audio files.');
    this.context = new AudioContextCtor();
    try {
      // decodeAudioData selects the audio track from supported containers,
      // including audio-bearing MP4s. The local source bytes are never sent.
      const bytes = await file.arrayBuffer();
      this.buffer = await this.context.decodeAudioData(bytes.slice(0));
      if (
        this.buffer.numberOfChannels <= 0
        || !Number.isFinite(this.buffer.duration)
        || this.buffer.duration <= 0
      ) throw recordingDecodeError(file);
    } catch {
      if (this.context.state !== 'closed') await this.context.close().catch(() => {});
      this.context = null;
      this.buffer = null;
      throw recordingDecodeError(file);
    }

    this.processor = this.context.createScriptProcessor(4096, Math.max(1, this.buffer.numberOfChannels), 1);
    this.encoder = new MonoPcm16Encoder(this.context.sampleRate);
    this.processor.onaudioprocess = event => {
      if (!this.callbacks || !this.source || !this.encoder) return;
      const channels = Array.from(
        { length: event.inputBuffer.numberOfChannels },
        (_, index) => event.inputBuffer.getChannelData(index),
      );
      this.callbacks.onPcm(this.encoder.encode(channels));
    };
    this.processor.connect(this.context.destination);
  }

  async play(callbacks: PlaybackCallbacks): Promise<void> {
    if (!this.context || !this.buffer || !this.processor) throw new Error('Audio is not ready');
    this.callbacks = callbacks;
    await this.context.resume();
    this.startSource();
    this.startProgressTimer();
  }

  async pause(): Promise<void> {
    if (!this.context || !this.source) return;
    this.offsetSeconds = this.currentSeconds;
    this.sourceGeneration += 1;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
    await this.context.suspend();
    this.stopProgressTimer();
  }

  async resume(): Promise<void> {
    if (!this.context || !this.buffer || this.source) return;
    await this.context.resume();
    this.startSource();
    this.startProgressTimer();
  }

  async stop(): Promise<void> {
    this.sourceGeneration += 1;
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.processor?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor = null;
    this.callbacks = null;
    this.stopProgressTimer();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
    this.buffer = null;
    this.encoder = null;
  }

  private startSource(): void {
    if (!this.context || !this.buffer || !this.processor) return;
    const source = this.context.createBufferSource();
    const generation = ++this.sourceGeneration;
    source.buffer = this.buffer;
    source.playbackRate.value = PLAYBACK_RATE;
    // Direct connection is the audible local playback. The parallel
    // processor branch observes the same real-time render blocks for PCM.
    source.connect(this.context.destination);
    source.connect(this.processor);
    source.onended = () => {
      if (generation !== this.sourceGeneration || this.source !== source) return;
      this.offsetSeconds = this.durationSeconds;
      this.source = null;
      this.stopProgressTimer();
      this.callbacks?.onProgress(this.offsetSeconds);
      this.callbacks?.onEnded();
    };
    this.startedAt = this.context.currentTime;
    this.source = source;
    source.start(0, this.offsetSeconds);
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => this.callbacks?.onProgress(this.currentSeconds), 250);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }
}

export function validateRecordingFile(file: File | null): string | null {
  if (!file) return 'Choose an audio recording first.';
  if (!file.type.toLowerCase().startsWith('audio/') && !isMp4RecordingFile(file)) {
    return 'Choose a supported audio file or an MP4 file with audio.';
  }
  if (file.size <= 0) return 'The selected file is empty.';
  if (file.size > 250 * 1024 * 1024) return 'Choose a recording smaller than 250 MB.';
  return null;
}

export function formatRecordingDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown';
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
