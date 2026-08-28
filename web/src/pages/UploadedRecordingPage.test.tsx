// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import UploadedRecordingPage from './UploadedRecordingPage';

const mocks = vi.hoisted(() => ({
  createMeeting: vi.fn(),
  getMeeting: vi.fn(),
  getSegments: vi.fn(),
  load: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  connect: vi.fn(), start: vi.fn(), sendPcm: vi.fn(), transportPause: vi.fn(), transportResume: vi.fn(), end: vi.fn(), waitForCompletion: vi.fn(), close: vi.fn(),
  scrollIntoView: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Rep' } }) }));
vi.mock('../lib/api', () => ({
  createUploadedRecordingMeeting: mocks.createMeeting,
  getMeeting: mocks.getMeeting,
  getMeetingSegments: mocks.getSegments,
}));
vi.mock('../lib/uploadedRecording', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/uploadedRecording')>();
  class Player {
    durationSeconds = 12;
    load = mocks.load;
    play = mocks.play;
    pause = mocks.pause;
    resume = mocks.resume;
    stop = mocks.stop;
  }
  class Transport {
    connect = mocks.connect;
    start = mocks.start;
    sendPcm = mocks.sendPcm;
    pause = mocks.transportPause;
    resume = mocks.transportResume;
    end = mocks.end;
    waitForCompletion = mocks.waitForCompletion;
    close = mocks.close;
  }
  return { ...actual, LocalRecordingPlayer: Player, UploadedRecordingTransport: Transport };
});

function LocationProbe() { return <output aria-label="location">{useLocation().pathname}</output>; }
function renderPage() {
  return render(<MemoryRouter initialEntries={['/recordings/analyze']}><Routes>
    <Route path="/recordings/analyze" element={<><UploadedRecordingPage /><LocationProbe /></>} />
    <Route path="/meetings/:id" element={<LocationProbe />} />
  </Routes></MemoryRouter>);
}

async function selectAudio() {
  const file = new File(['audio'], 'customer-call.wav', { type: 'audio/wav' });
  await userEvent.upload(screen.getByLabelText('Local audio or MP4 file'), file);
  const audio = screen.getByLabelText('Selected recording playback');
  Object.defineProperty(audio, 'duration', { configurable: true, value: 12 });
  fireEvent.loadedMetadata(audio);
  return file;
}

async function startAnalysis() {
  let applyLiveMessage: ((message: unknown) => void) | undefined;
  mocks.connect.mockImplementation(async (handler: (message: unknown) => void) => {
    applyLiveMessage = handler;
  });
  renderPage();
  await selectAudio();
  await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
  await waitFor(() => expect(applyLiveMessage).toBeTruthy());
  await screen.findByRole('heading', { name: 'Live transcript' });
  return applyLiveMessage!;
}

function getTranscriptContainer() {
  return screen.getByLabelText('Live transcript');
}

function setTranscriptScrollMetrics(element: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: values.scrollHeight },
    clientHeight: { configurable: true, value: values.clientHeight },
    scrollTop: { configurable: true, writable: true, value: values.scrollTop },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:local-only'), revokeObjectURL: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: mocks.scrollIntoView });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  mocks.createMeeting.mockResolvedValue({ id: 'meeting-upload-1', upload_ws_path: '/meetings/meeting-upload-1/uploaded-recording' });
  mocks.connect.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.pause.mockResolvedValue(undefined);
  mocks.resume.mockResolvedValue(undefined);
  mocks.play.mockResolvedValue(undefined);
  mocks.end.mockReturnValue(true);
  mocks.waitForCompletion.mockResolvedValue({ type: 'completed' });
  mocks.getMeeting.mockResolvedValue({ id: 'meeting-upload-1', status: 'completed' });
  mocks.getSegments.mockResolvedValue({ segments: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UploadedRecordingPage', () => {
  it('makes MP4 recordings selectable alongside existing audio formats', () => {
    renderPage();
    const input = screen.getByLabelText('Local audio or MP4 file');
    expect(input.getAttribute('accept')).toContain('audio/*');
    expect(input.getAttribute('accept')).toContain('video/mp4');
    expect(input.getAttribute('accept')).toContain('.mp4');
  });

  it('shows privacy copy, file metadata, and gates start on authority acknowledgment', async () => {
    renderPage();
    expect(screen.getByText(/source file stays on this device/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);
    await selectAudio();
    expect(screen.getByText('customer-call.wav')).toBeTruthy();
    expect(screen.getByText('audio/wav')).toBeTruthy();
    expect(screen.getByText('0:12')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', false);
  });

  it('waits for the server start acknowledgement before local playback begins', async () => {
    let acknowledgeStart: (() => void) | undefined;
    mocks.start.mockImplementation(() => new Promise<void>(resolve => { acknowledgeStart = resolve; }));
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ durationSeconds: 12 }));
    expect(mocks.play).not.toHaveBeenCalled();
    acknowledgeStart!();
    await waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
  });

  it('creates the uploaded_recording meeting, locks seek/rate, and exposes pause/stop controls', async () => {
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ durationSeconds: 12 }));
    expect(mocks.createMeeting).toHaveBeenCalledWith(12);
    expect(mocks.load).toHaveBeenCalledBefore(mocks.createMeeting);
    expect(screen.getByText(/Seeking and playback-speed changes are locked/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(mocks.pause).toHaveBeenCalled();
    expect(mocks.transportPause).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(mocks.transportResume).toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1'));
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalled();
  });

  it('handles duplicate EOF callbacks with one end/finalization', async () => {
    let playbackCallbacks: { onEnded: () => void } | undefined;
    mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(playbackCallbacks).toBeTruthy());
    playbackCallbacks!.onEnded();
    playbackCallbacks!.onEnded();
    await waitFor(() => expect(mocks.getMeeting).toHaveBeenCalledTimes(1));
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it('shows errors with retry before playback starts', async () => {
    mocks.createMeeting.mockRejectedValueOnce(new Error('Network unavailable'));
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable');
    expect(screen.getByRole('button', { name: /Retry Analysis/ })).toBeTruthy();
  });

  it('surfaces an MP4 audio-track decode error without creating a server meeting', async () => {
    mocks.load.mockRejectedValueOnce(new Error('ARIA could not find a decodable audio track in this MP4 file. Choose an MP4 with audio and retry.'));
    renderPage();
    const file = new File(['video-only'], 'silent.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByLabelText('Local audio or MP4 file'), file);
    const audio = screen.getByLabelText('Selected recording playback');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(audio);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/decodable audio track.*MP4/i);
    expect(mocks.createMeeting).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('revokes its local object URL on replacement/unmount', async () => {
    const { unmount } = renderPage();
    await selectAudio();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-only');
  });

  it('does not move the document viewport when live transcript updates arrive', async () => {
    const applyLiveMessage = await startAnalysis();
    mocks.scrollIntoView.mockClear();

    applyLiveMessage({ type: 'interim', text: 'Working through the details' });

    await screen.findByText('Working through the details');
    expect(mocks.scrollIntoView).not.toHaveBeenCalled();
  });

  it('auto-scrolls only the transcript container while following live updates', async () => {
    const applyLiveMessage = await startAnalysis();
    const transcript = getTranscriptContainer();
    setTranscriptScrollMetrics(transcript, { scrollHeight: 600, clientHeight: 200, scrollTop: 350 });

    applyLiveMessage({ type: 'interim', text: 'A new live phrase' });

    await screen.findByText('A new live phrase');
    await waitFor(() => expect(transcript.scrollTop).toBe(600));
  });

  it('preserves transcript position when the user scrolls more than 80px from the bottom', async () => {
    const applyLiveMessage = await startAnalysis();
    const transcript = getTranscriptContainer();
    setTranscriptScrollMetrics(transcript, { scrollHeight: 600, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(transcript);
    mocks.scrollIntoView.mockClear();

    applyLiveMessage({ type: 'interim', text: 'Do not chase this update' });

    await screen.findByText('Do not chase this update');
    expect(transcript.scrollTop).toBe(100);
    expect(mocks.scrollIntoView).not.toHaveBeenCalled();
  });

  it('resumes transcript-container auto-follow after the user returns within 80px of the bottom', async () => {
    const applyLiveMessage = await startAnalysis();
    const transcript = getTranscriptContainer();
    setTranscriptScrollMetrics(transcript, { scrollHeight: 600, clientHeight: 200, scrollTop: 100 });
    fireEvent.scroll(transcript);
    transcript.scrollTop = 330;
    fireEvent.scroll(transcript);

    applyLiveMessage({ type: 'interim', text: 'Follow updates again' });

    await screen.findByText('Follow updates again');
    await waitFor(() => expect(transcript.scrollTop).toBe(600));
  });
});
