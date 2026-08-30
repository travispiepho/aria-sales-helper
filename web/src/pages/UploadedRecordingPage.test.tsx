// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import UploadedRecordingPage from './UploadedRecordingPage';

const mocks = vi.hoisted(() => ({
  createMeeting: vi.fn(),
  getMeeting: vi.fn(),
  getSegments: vi.fn(),
  updateMeeting: vi.fn(),
  load: vi.fn(), play: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  connect: vi.fn(), start: vi.fn(), sendPcm: vi.fn(), transportPause: vi.fn(), transportResume: vi.fn(), end: vi.fn(), waitForCompletion: vi.fn(), close: vi.fn(),
  scrollIntoView: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Rep' } }) }));
vi.mock('../lib/api', () => ({
  createUploadedRecordingMeeting: mocks.createMeeting,
  getMeeting: mocks.getMeeting,
  getMeetingSegments: mocks.getSegments,
  updateMeeting: mocks.updateMeeting,
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
    <Route path="/meetings/:id/post" element={<LocationProbe />} />
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

function expectThreeColumnWorkspace() {
  const workspace = document.querySelector('[data-active-meeting-layout="three-column"]');
  expect(workspace).toBeTruthy();
  const columns = Array.from(workspace!.querySelectorAll(':scope > [data-meeting-column]'));
  expect(columns.map(column => column.getAttribute('data-meeting-column'))).toEqual([
    'feedback',
    'transcript',
    'type',
  ]);
  const right = workspace!.querySelector('[data-meeting-column="transcript"]')!;
  const rename = right.querySelector('[data-speaker-controls]')!;
  const transcript = right.querySelector('[data-live-transcript]')!;
  expect(rename.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(workspace!.querySelector('[data-meeting-column="type"] [data-meeting-end-control]')).toBeTruthy();
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
  mocks.updateMeeting.mockResolvedValue({ id: 'meeting-upload-1', status: 'active', speaker_labels: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UploadedRecordingPage', () => {
  it('renders the complete uploaded workflow in the shared three-column active structure', () => {
    renderPage();
    expectThreeColumnWorkspace();
    const feedback = screen.getByRole('region', { name: 'ARIA Feedback' });
    const coaching = screen.getByRole('region', { name: 'ARIA Coaching' });
    expect(feedback.contains(coaching)).toBe(true);
    expect(Array.from(coaching.querySelectorAll('[data-coaching-waiting]')).map(node => node.textContent)).toEqual([
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
    ]);
    const typeColumn = document.querySelector('[data-meeting-column="type"]')!;
    expect(typeColumn.contains(screen.getByRole('group', { name: 'Choose a recording' }))).toBe(true);
    expect(typeColumn.contains(screen.getByRole('heading', { name: 'Playback & analysis controls' }))).toBe(true);
    expect(typeColumn.contains(screen.getByRole('checkbox'))).toBe(true);
    expect(typeColumn.contains(screen.getByRole('button', { name: /Start Analysis/ }))).toBe(true);
    expect(typeColumn.contains(screen.getByRole('button', { name: /End Meeting/ }))).toBe(true);
    expect(screen.queryByText(/Stop Analysis/)).toBeNull();
  });

  // 2026-08-29 (aria_left_panel_title_type_duration): this page's title
  // block gets the same "title + type label together" row-1 treatment as
  // MeetingPage.tsx's in-person/phone blocks, with the existing "Active ·
  // local playback..." line remaining the distinct second row directly
  // below (this page has no elapsed-timer duration value to isolate here
  // — see the code comment at this block for why).
  it('renders the title and "Uploaded Recording" type label together on row 1, with the status line as a distinct row 2', () => {
    renderPage();
    const statusBlock = document.querySelector('[data-meeting-status-location="left-column"]')!;
    expect(statusBlock).toBeTruthy();
    const titleEl = within(statusBlock as HTMLElement).getByText('Analyze a Recording');
    const typeLabelEl = statusBlock.querySelector('[data-meeting-type-label="left-column"]')!;
    expect(typeLabelEl.textContent).toBe('Uploaded Recording');
    // Title and type label share row 1's parent container.
    expect(titleEl.parentElement).toBe(typeLabelEl.parentElement);
    const statusLine = within(statusBlock as HTMLElement).getByText(/^Active · local playback with live ARIA coaching$/);
    // Status/duration line is a sibling of the title+type row, not nested
    // inside it.
    expect(statusLine.parentElement).toBe(statusBlock);
    expect(titleEl.parentElement).not.toBe(statusBlock);
  });

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

  it('renders one recording chooser inside the bottom playback and analysis controls', async () => {
    renderPage();

    const controls = screen.getByRole('region', { name: 'Playback and analysis controls' });
    const chooser = screen.getByRole('group', { name: 'Choose a recording' });
    const input = screen.getByLabelText('Local audio or MP4 file');

    expect(screen.getAllByRole('heading', { name: 'Choose a recording' })).toHaveLength(1);
    expect(screen.getAllByLabelText('Local audio or MP4 file')).toHaveLength(1);
    expect(controls.contains(chooser)).toBe(true);
    expect(chooser.contains(input)).toBe(true);

    await selectAudio();

    const transcript = screen.getByRole('region', { name: 'Transcript' });
    const playback = screen.getByLabelText('Selected recording playback');
    const consent = screen.getByRole('checkbox');
    const start = screen.getByRole('button', { name: /Start Analysis/ });

    expect(transcript.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.compareDocumentPosition(playback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(playback.compareDocumentPosition(consent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(consent.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the entire Choose a recording section once analysis is active, and shows it again while no analysis is active', async () => {
    renderPage();
    expect(screen.getByRole('group', { name: 'Choose a recording' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose a recording' })).toBeTruthy();
    expect(screen.getByLabelText('Local audio or MP4 file')).toBeTruthy();

    await selectAudio();
    // A file is selected but Start Analysis has not been clicked yet
    // (`active` is still false at this point) — the chooser stays visible
    // so the user can still pick a different file before starting.
    expect(screen.getByRole('group', { name: 'Choose a recording' })).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await screen.findByRole('heading', { name: 'Live transcript' });

    // Now analysis is active: the whole section must be gone, not merely
    // disabled.
    expect(screen.queryByRole('group', { name: 'Choose a recording' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Choose a recording' })).toBeNull();
    expect(screen.queryByLabelText('Local audio or MP4 file')).toBeNull();
    expect(screen.queryByText(/Your source file stays on this device/i)).toBeNull();

    // Surrounding sections remain unaffected while active.
    expect(screen.getByRole('heading', { name: 'Playback & analysis controls' })).toBeTruthy();
    expect(screen.getByLabelText('Selected recording playback')).toBeTruthy();
    expect(screen.getByRole('button', { name: /End Meeting/ })).toBeTruthy();
  });

  it('shows the Choose a recording section again after a fresh mount following completion (no active/selected file)', async () => {
    const { unmount } = renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await screen.findByRole('heading', { name: 'Live transcript' });
    expect(screen.queryByRole('group', { name: 'Choose a recording' })).toBeNull();

    // This page always navigates away on completion (to the post-recording
    // route on a different component), so a returning user gets a fresh
    // mount with `active` back to false rather than this same instance
    // staying mounted mid-analysis. Simulate that fresh instance here.
    unmount();
    renderPage();
    expect(screen.getByRole('group', { name: 'Choose a recording' })).toBeTruthy();
    expect(screen.getByLabelText('Local audio or MP4 file')).toBeTruthy();
  });

  it('orders coaching above the transcript and groups playback details, progress, and controls below it', async () => {
    await startAnalysis();

    const coaching = screen.getByRole('region', { name: 'ARIA Coaching' });
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    const controls = screen.getByRole('region', { name: 'Playback and analysis controls' });

    expect(coaching.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(transcript.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls.contains(screen.getByText('customer-call.wav'))).toBe(true);
    expect(controls.contains(screen.getByLabelText('Selected recording playback'))).toBe(true);
    expect(controls.contains(screen.getByLabelText('Playback progress'))).toBe(true);
    expect(controls.contains(screen.getByRole('button', { name: /Start Analysis/ }))).toBe(true);
    expect(controls.contains(screen.getByRole('button', { name: /Pause/ }))).toBe(true);
    expect(controls.contains(screen.getByRole('button', { name: /End Meeting/ }))).toBe(true);
  });

  it('renders all 11 uploaded-recording coaching checklist items in the shared wrapped grid', async () => {
    const applyLiveMessage = await startAnalysis();
    const waitingPanel = screen.getByRole('region', { name: 'ARIA Coaching' });
    const checklist = Array.from({ length: 11 }, (_, index) => ({
      id: `upload-item-${index + 1}`,
      label: `Uploaded checklist item ${index + 1}`,
      done: index < 4,
    }));

    applyLiveMessage({
      type: 'coaching',
      data: {
        disc: { detected: 'S', confidence: 'medium', emoji: '🤝', label: 'Steady', tip: 'Keep building trust.' },
        stage: { current: 'first_go_around', label: 'First Go Around' },
        checklist,
        nudges: ['Continue the walkthrough.'],
        urgent: null,
      },
    });

    await screen.findByText('Uploaded checklist item 11');
    const coaching = screen.getByRole('region', { name: 'ARIA Coaching' });
    expect(coaching).toBe(waitingPanel);
    const grid = coaching.querySelector('[data-coaching-checklist]');
    expect(grid).toBeTruthy();
    expect(grid!.className).toContain('sm:grid-cols-2');
    expect(coaching.querySelectorAll('[data-coaching-checklist-item]')).toHaveLength(11);
    expect(screen.getByText('4/11')).toBeTruthy();
    expect(coaching.querySelector('[data-coaching-waiting="disc"]')).toBeNull();
    expect(coaching.querySelector('[data-coaching-waiting="stage"]')).toBeNull();
    expect(coaching.querySelector('[data-coaching-waiting="checklist"]')).toBeNull();
    expect(coaching.querySelector('[data-coaching-waiting="nudges"]')).toBeNull();
    expect(coaching.querySelector('[data-coaching-waiting="urgent"]')?.textContent).toBe('Waiting on data...');
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

  it('creates the uploaded_recording meeting, locks seek/rate, and exposes pause/End Meeting controls', async () => {
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
    // Clicking End Meeting shows a confirmation dialog (parity with
    // MeetingPage.tsx's in-person End Meeting flow) before finalize() runs.
    await userEvent.click(screen.getByRole('button', { name: /End Meeting/ }));
    expect(mocks.end).not.toHaveBeenCalled();
    const confirmDialog = await screen.findByText('End this meeting?');
    const confirmButton = within(confirmDialog.closest('div.bg-white') as HTMLElement).getByRole('button', { name: /End Meeting/ });
    await userEvent.click(confirmButton);
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalled();
  });

  it('updates transcript labels immediately and persists speaker renames through the meeting API', async () => {
    const applyLiveMessage = await startAnalysis();
    applyLiveMessage({ type: 'final', id: 'segment-1', speaker: 'Speaker 1', text: 'Thanks for meeting today.' });

    await screen.findByText('Thanks for meeting today.');
    const rename = screen.getByRole('textbox', { name: 'Rename Speaker 1' });
    await userEvent.type(rename, 'Taylor');

    expect(screen.getByText('Taylor:')).toBeTruthy();
    await waitFor(() => expect(mocks.updateMeeting).toHaveBeenLastCalledWith('meeting-upload-1', {
      speaker_labels: { 'Speaker 1': 'Taylor' },
    }));
  });

  it('applies automatic speaker locks to prior live rows without echoing a stale PATCH', async () => {
    const applyLiveMessage = await startAnalysis();
    applyLiveMessage({ type: 'final', id: 'segment-1', speaker: 'Speaker 1', text: 'Hi John, this is Ada.' });
    await screen.findByText('Hi John, this is Ada.');

    applyLiveMessage({ type: 'speaker_lock', speakerId: 'Speaker 1', name: 'Ada', source: 'introduction' });

    expect(await screen.findByText('Ada:')).toBeTruthy();
    expect(mocks.updateMeeting).not.toHaveBeenCalled();
  });

  it('only links to completed meeting analysis after server-confirmed finalization', async () => {
    let playbackCallbacks: { onEnded: () => void } | undefined;
    let acknowledgeCompletion: (() => void) | undefined;
    mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
    mocks.waitForCompletion.mockImplementation(() => new Promise(resolve => {
      acknowledgeCompletion = () => resolve({ type: 'completed' });
    }));

    renderPage();
    expect(screen.queryByRole('button', { name: 'View completed meeting analysis' })).toBeNull();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(playbackCallbacks).toBeTruthy());

    expect(screen.queryByRole('button', { name: 'View completed meeting analysis' })).toBeNull();
    playbackCallbacks!.onEnded();
    await waitFor(() => expect(mocks.waitForCompletion).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'View completed meeting analysis' })).toBeNull();

    acknowledgeCompletion!();
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));
  });

  it('stops local playback and shows a truthful error when transport disconnects midstream', async () => {
    let disconnect: ((error: Error) => void) | undefined;
    mocks.connect.mockImplementation(async (_handler: (message: unknown) => void, onDisconnect: (error: Error) => void) => {
      disconnect = onDisconnect;
    });
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(disconnect).toBeTruthy());

    disconnect!(new Error('ARIA lost the playback connection. Playback stopped to prevent missing or duplicated transcript audio. Retry the analysis.'));

    expect((await screen.findByRole('alert')).textContent).toMatch(/lost the playback connection.*Playback stopped/i);
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.end).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Retry Analysis/ })).toBeTruthy();
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
    await waitFor(() => expect(mocks.waitForCompletion).toHaveBeenCalledTimes(1));
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.getMeeting).not.toHaveBeenCalled();
  });

  it('treats a terminal meeting as complete when a non-critical follow-up closes the socket with Completion failed', async () => {
    let playbackCallbacks: { onEnded: () => void } | undefined;
    let applyLiveMessage: ((message: unknown) => void) | undefined;
    mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
    mocks.connect.mockImplementation(async (handler: (message: unknown) => void) => { applyLiveMessage = handler; });
    mocks.waitForCompletion.mockRejectedValueOnce(new Error('ARIA closed the connection before analysis completed. Retry.'));
    mocks.getMeeting.mockResolvedValueOnce({ id: 'meeting-upload-1', status: 'completed' });

    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(playbackCallbacks).toBeTruthy());

    // This reproduces the observed ordering: the old server surfaced a
    // post-status summary/follow-up exception as a generic completion error,
    // then closed the socket even though the meeting row was already terminal.
    applyLiveMessage!({ type: 'error', error: 'Completion failed' });
    playbackCallbacks!.onEnded();

    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));
    expect(screen.queryByText('Completion failed')).toBeNull();
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.getMeeting).toHaveBeenCalledWith('meeting-upload-1');
  });

  it('keeps a completion error visible when the meeting is genuinely still active', async () => {
    let playbackCallbacks: { onEnded: () => void } | undefined;
    mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
    mocks.waitForCompletion.mockRejectedValueOnce(new Error('Completion failed'));
    mocks.getMeeting.mockResolvedValueOnce({ id: 'meeting-upload-1', status: 'active' });

    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(playbackCallbacks).toBeTruthy());
    playbackCallbacks!.onEnded();

    expect((await screen.findByRole('alert')).textContent).toContain('Completion failed');
    expect(screen.getByLabelText('location').textContent).toBe('/recordings/analyze');
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
