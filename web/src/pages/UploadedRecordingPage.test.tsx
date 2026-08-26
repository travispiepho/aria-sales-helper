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
  connect: vi.fn(), start: vi.fn(), sendPcm: vi.fn(), transportPause: vi.fn(), transportResume: vi.fn(), end: vi.fn(), close: vi.fn(),
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
  await userEvent.upload(screen.getByLabelText('Local audio file'), file);
  const audio = screen.getByLabelText('Selected recording playback');
  Object.defineProperty(audio, 'duration', { configurable: true, value: 12 });
  fireEvent.loadedMetadata(audio);
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:local-only'), revokeObjectURL: vi.fn() });
  mocks.createMeeting.mockResolvedValue({ id: 'meeting-upload-1' });
  mocks.connect.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.pause.mockResolvedValue(undefined);
  mocks.resume.mockResolvedValue(undefined);
  mocks.play.mockResolvedValue(undefined);
  mocks.end.mockReturnValue(true);
  mocks.getMeeting.mockResolvedValue({ id: 'meeting-upload-1', status: 'completed' });
  mocks.getSegments.mockResolvedValue({ segments: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UploadedRecordingPage', () => {
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

  it('creates the uploaded_recording meeting, locks seek/rate, and exposes pause/stop controls', async () => {
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ durationMs: 12000, fileName: 'customer-call.wav', mimeType: 'audio/wav' }));
    expect(mocks.createMeeting).toHaveBeenCalledTimes(1);
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

  it('revokes its local object URL on replacement/unmount', async () => {
    const { unmount } = renderPage();
    await selectAudio();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-only');
  });
});
