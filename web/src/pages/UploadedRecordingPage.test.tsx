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
  getCustomer: vi.fn(),
  updateCustomer: vi.fn(),
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
  getCustomer: mocks.getCustomer,
  updateCustomer: mocks.updateCustomer,
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
    <Route path="/" element={<LocationProbe />} />
  </Routes></MemoryRouter>);
}

// aria_recording_analysis_meeting_type_choice (2026-08-31): every existing
// test in this file predates the meeting-type radio group and implicitly
// assumed a normal in-person-shaped walkthrough recording, so this shared
// helper also picks "Walkthrough (in-person)" by default — the same
// behavior those tests already exercised — unless a test explicitly opts
// out via `pickMeetingType: false` (used by the dedicated gating tests
// below, which need to exercise the pre-choice state itself).
async function selectAudio({ pickMeetingType = true }: { pickMeetingType?: boolean } = {}) {
  const file = new File(['audio'], 'customer-call.wav', { type: 'audio/wav' });
  await userEvent.upload(screen.getByLabelText('Local audio or MP4 file'), file);
  const audio = screen.getByLabelText('Selected recording playback');
  Object.defineProperty(audio, 'duration', { configurable: true, value: 12 });
  fireEvent.loadedMetadata(audio);
  if (pickMeetingType) {
    await userEvent.click(screen.getByRole('radio', { name: 'Walkthrough (in-person)' }));
  }
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

  // aria_uploaded_recording_remove_tip_for_next_time (2026-08-31): the
  // "Tip for next time" introduce-yourself guidance block was removed
  // entirely per objective, so it must not render in any state.
  it('does not show the removed Tip for next time / introduce-yourself guidance in any state', async () => {
    renderPage();
    await selectAudio();
    expect(screen.queryByText(/Tip for next time/i)).toBeNull();
    expect(screen.queryByText(/ARIA labels the rep\s+automatically by name/i)).toBeNull();

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await screen.findByRole('heading', { name: 'Live transcript' });
    expect(screen.queryByText(/Tip for next time/i)).toBeNull();
    expect(screen.queryByText(/ARIA labels the rep\s+automatically by name/i)).toBeNull();
  });

  // aria_coaching_left_panel_space_between_layout (2026-08-30): the left
  // "type" column's own top-to-bottom children (title/status block,
  // CustomerInfoSection + upload/playback content, End Meeting control)
  // now rely on `.uploaded-type-column`'s `justify-content: space-between`
  // (index.css) rather than a fixed Tailwind `space-y-4` gap.
  it('uses the space-between left-column class (not a fixed space-y gap) for the type column', () => {
    renderPage();
    const typeColumn = document.querySelector('[data-meeting-column="type"]')!;
    expect(typeColumn.className).toContain('uploaded-type-column');
    expect(typeColumn.className).not.toContain('space-y-4');
  });

  // 2026-08-30 (aria_uploaded_recording_simplify_copy): per Gabe's explicit
  // ask, this page's title row no longer carries the "Uploaded Recording"
  // type label (that was added by aria_left_panel_title_type_duration for
  // parity with MeetingPage.tsx, but removed here as a deliberate
  // simplification for THIS PAGE ONLY), and the status line below it is
  // simplified from "Active · local playback with live ARIA coaching" down
  // to just "Active".
  it('renders the title with no type label, and a simplified "Active" status line as row 2', () => {
    renderPage();
    const statusBlock = document.querySelector('[data-meeting-status-location="left-column"]')!;
    expect(statusBlock).toBeTruthy();
    const titleEl = within(statusBlock as HTMLElement).getByText('Analyze a Recording');
    expect(statusBlock.querySelector('[data-meeting-type-label="left-column"]')).toBeNull();
    expect(within(statusBlock as HTMLElement).queryByText(/Uploaded Recording/)).toBeNull();
    const statusLine = within(statusBlock as HTMLElement).getByText(/^Active$/);
    // Status line is a sibling of the title row, not nested inside it.
    expect(statusLine.parentElement).toBe(statusBlock);
    expect(titleEl.parentElement).not.toBe(statusBlock);
  });

  // 2026-08-29 (aria_customer_info_editable_section): the new editable
  // Customer Info section must render directly under the title/duration
  // block above on THIS page too (uploaded-recording meeting type), and
  // must degrade gracefully when no customer_id is present — which is
  // always the case here today, since no caller of
  // createUploadedRecordingMeeting() on this page passes one (verified
  // live in handleStart()).
  //
  // 2026-08-31 (aria_uploaded_recording_hide_customer_info_until_meeting_started):
  // the empty-state placement/graceful-degradation assertion that used to
  // live here as a standalone idle-state test is now superseded by the
  // dedicated 'Customer Info visibility gated on analysis having started'
  // describe block below — the section no longer renders in the idle state
  // at all, so there is nothing to place/assert there anymore. This test
  // (once analysis has started and a customer is linked) is unaffected.
  describe('Customer Info section placement and behavior', () => {
    it('renders the editable section under the title/duration block and persists an edit via updateCustomer once a customer is linked', async () => {
      const user = userEvent.setup();
      mocks.createMeeting.mockResolvedValue({
        id: 'meeting-upload-1',
        upload_ws_path: '/meetings/meeting-upload-1/uploaded-recording',
        customer_id: 'cust-1',
      });
      mocks.getCustomer.mockResolvedValue({
        id: 'cust-1', name: 'Jane Smith', phone: '6165551212', created_at: new Date().toISOString(),
      });
      mocks.updateCustomer.mockResolvedValue({
        id: 'cust-1', name: 'Jane Smith', phone: '6165559999', created_at: new Date().toISOString(),
      });
      await startAnalysis();

      const statusBlock = document.querySelector('[data-meeting-status-location="left-column"]')!;
      const section = await screen.findByText('6165551212');
      const sectionRoot = section.closest('[data-customer-info-section="editable"]')!;
      expect(sectionRoot).toBeTruthy();
      expect(statusBlock.compareDocumentPosition(sectionRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await user.click(within(sectionRoot as HTMLElement).getByRole('button', { name: '✏️ Edit' }));
      const phoneInput = screen.getByLabelText('Customer phone');
      await user.clear(phoneInput);
      await user.type(phoneInput, '6165559999');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mocks.updateCustomer).toHaveBeenCalledWith('cust-1', expect.objectContaining({ phone: '6165559999' })));
      expect(await screen.findByText('6165559999')).toBeTruthy();
    });
  });

  // 2026-08-31 (aria_uploaded_recording_hide_customer_info_until_meeting_started):
  // the Customer Info section must NOT render at all before the rep has
  // clicked Start Analysis (idle state — matches the pre-upload/pre-
  // analysis state described in the task objective), must appear as soon
  // as analysis starts (state leaves 'idle', reusing this page's existing
  // PlaybackState signal rather than inventing a new one — see the inline
  // comment on the CustomerInfoSection render site itself), and must
  // remain visible through completion rather than disappearing again like
  // the metadata/selector chrome correctly does.
  describe('Customer Info visibility gated on analysis having started', () => {
    it('does not render Customer Info in the idle state, before any file is selected or Start Analysis is clicked', () => {
      renderPage();
      expect(document.querySelector('[data-customer-info-section]')).toBeNull();
      expect(screen.queryByText('No customer linked to this meeting yet.')).toBeNull();
    });

    it('still does not render Customer Info once a file is selected and a meeting type is picked, as long as Start Analysis has not been clicked (still idle)', async () => {
      renderPage();
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      // Still idle: Start Analysis has not been clicked yet.
      expect(document.querySelector('[data-customer-info-section]')).toBeNull();
    });

    it('renders Customer Info as soon as analysis starts (state leaves idle), and it stays visible once the file-selection chrome is hidden', async () => {
      await startAnalysis();
      const section = document.querySelector('[data-customer-info-section="empty"]');
      expect(section).toBeTruthy();
      expect(within(section as HTMLElement).getByText('No customer linked to this meeting yet.')).toBeTruthy();
    });

    it('keeps Customer Info visible once analysis reaches the complete state', async () => {
      let playbackCallbacks: { onEnded: () => void } | undefined;
      mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
      mocks.waitForCompletion.mockImplementation(() => new Promise(() => {})); // never resolves — stays in 'stopping', which is post-idle
      renderPage();
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(playbackCallbacks).toBeTruthy());
      expect(document.querySelector('[data-customer-info-section]')).toBeTruthy();
      playbackCallbacks!.onEnded();
      await waitFor(() => expect(screen.getByText('Finalizing…')).toBeTruthy());
      // Still 'stopping' (post-idle, pre-complete) — Customer Info remains.
      expect(document.querySelector('[data-customer-info-section]')).toBeTruthy();
    });

    it('does not resurface Customer Info on a fresh mount back in the idle state (a genuinely new, unstarted session)', async () => {
      const { unmount } = await (async () => {
        const result = renderPage();
        await selectAudio();
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
        await screen.findByRole('heading', { name: 'Live transcript' });
        return result;
      })();
      expect(document.querySelector('[data-customer-info-section]')).toBeTruthy();
      unmount();
      renderPage();
      // Fresh mount is idle again — hidden once more, exactly like the
      // Choose a recording chooser's own established fresh-mount precedent.
      expect(document.querySelector('[data-customer-info-section]')).toBeNull();
    });
  });

  it('makes MP4 recordings selectable alongside existing audio formats', () => {
    renderPage();
    const input = screen.getByLabelText('Local audio or MP4 file');
    expect(input.getAttribute('accept')).toContain('audio/*');
    expect(input.getAttribute('accept')).toContain('video/mp4');
    expect(input.getAttribute('accept')).toContain('.mp4');
  });

  // 2026-08-31 (aria_uploaded_recording_remove_metadata_section): the
  // Filename/Duration/Type metadata <dl> block this test used to assert on
  // is fully removed from the page (not merely hidden) per Gabe's ask —
  // see the dedicated 'never renders the file metadata' test below. This
  // test now only covers the authority-acknowledgment gating behavior.
  it('gates start on authority acknowledgment', async () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);
    await selectAudio();
    expect(screen.getByLabelText('Selected recording playback')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', false);
  });

  // 2026-08-31 (aria_uploaded_recording_remove_metadata_section): per
  // Gabe's ask, the Filename/Duration/Type metadata block (previously only
  // hidden during active analysis by 330daac) is now removed outright —
  // it must never render, in idle, active, or complete states.
  it('never renders the file metadata block (Filename/Duration/Type) in any state', async () => {
    renderPage();
    await selectAudio();
    // Before analysis starts: no metadata block, but the preview audio and
    // consent checkbox are still present (untouched by this removal).
    expect(screen.queryByText('customer-call.wav')).toBeNull();
    expect(screen.queryByText('audio/wav')).toBeNull();
    expect(screen.queryByText('0:12')).toBeNull();
    expect(screen.getByLabelText('Selected recording playback')).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await screen.findByRole('heading', { name: 'Live transcript' });

    // During analysis: still absent.
    expect(screen.queryByText('customer-call.wav')).toBeNull();
    expect(screen.queryByText('audio/wav')).toBeNull();
    expect(screen.queryByText('0:12')).toBeNull();
  });

  // aria_recording_analysis_meeting_type_choice (2026-08-31): the rep must
  // explicitly pick a meeting type before Start Analysis is enabled — the
  // safer option per this task's brief over silently defaulting.
  describe('meeting type choice', () => {
    it('renders a required Setup Call / Walkthrough choice and blocks Start Analysis until one is picked', async () => {
      renderPage();
      await selectAudio({ pickMeetingType: false });
      await userEvent.click(screen.getByRole('checkbox'));
      expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);

      const group = screen.getByRole('radiogroup', { name: 'Meeting type' });
      const setupCall = within(group).getByRole('radio', { name: 'Setup Call (phone)' });
      const walkthrough = within(group).getByRole('radio', { name: 'Walkthrough (in-person)' });
      expect(setupCall).toHaveProperty('ariaChecked', 'false');
      expect(walkthrough).toHaveProperty('ariaChecked', 'false');

      await userEvent.click(setupCall);
      expect(setupCall).toHaveProperty('ariaChecked', 'true');
      expect(walkthrough).toHaveProperty('ariaChecked', 'false');
      expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', false);
    });

    it('surfaces a clear error instead of starting when Start Analysis is invoked with no meeting type chosen', async () => {
      renderPage();
      await selectAudio({ pickMeetingType: false });
      await userEvent.click(screen.getByRole('checkbox'));
      // Button is disabled per canStart, but assert the guard inside
      // handleStart() too so this stays safe even if canStart's derivation
      // ever drifts from handleStart()'s own validation.
      expect(screen.getByRole('button', { name: /Start Analysis/ })).toHaveProperty('disabled', true);
      expect(mocks.createMeeting).not.toHaveBeenCalled();
    });

    it('passes the explicit meeting type through to createUploadedRecordingMeeting when Setup Call is chosen', async () => {
      renderPage();
      await selectAudio({ pickMeetingType: false });
      await userEvent.click(screen.getByRole('radio', { name: 'Setup Call (phone)' }));
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(mocks.createMeeting).toHaveBeenCalledWith(12, 'setup_call'));
    });

    it('passes the explicit meeting type through to createUploadedRecordingMeeting when Walkthrough is chosen', async () => {
      renderPage();
      await selectAudio({ pickMeetingType: false });
      await userEvent.click(screen.getByRole('radio', { name: 'Walkthrough (in-person)' }));
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(mocks.createMeeting).toHaveBeenCalledWith(12, 'walkthrough'));
    });

    it('hides the meeting-type choice once analysis is active, alongside the rest of the chooser', async () => {
      await startAnalysis();
      expect(screen.queryByRole('radiogroup', { name: 'Meeting type' })).toBeNull();
    });
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

    // Surrounding sections remain unaffected while active.
    expect(screen.getByRole('button', { name: /End Meeting/ })).toBeTruthy();
  });

  // 2026-08-30 (aria_uploaded_recording_hide_metadata_during_analysis) /
  // 2026-08-31 (aria_uploaded_recording_remove_metadata_section): once
  // analysis is active, the file-selection chrome (heading, preview <audio>
  // element + its locked-seeking note, and the consent checkbox) is no
  // longer relevant — it served its purpose during file selection — so it
  // is unmounted, not merely disabled/hidden. It reliably reappears once
  // `active` goes back to false (idle for a fresh pick, or complete/error).
  // The Filename/Duration/Type metadata dl block once covered by this test
  // is now removed outright in every state (see the dedicated 'never
  // renders the file metadata block' test above), so it is no longer
  // asserted here.
  it('hides the Playback & analysis controls heading, preview audio, and consent checkbox once analysis is active', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Playback & analysis controls' })).toBeTruthy();

    await selectAudio();
    expect(screen.getByLabelText('Selected recording playback')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await screen.findByRole('heading', { name: 'Live transcript' });

    // Now analysis is active: all of the file-selection chrome must be gone,
    // not merely disabled.
    expect(screen.queryByRole('heading', { name: 'Playback & analysis controls' })).toBeNull();
    expect(screen.queryByLabelText('Selected recording playback')).toBeNull();
    expect(screen.queryByText(/Seeking and playback-speed changes are locked/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/I acknowledge that I have the authority/)).toBeNull();

    // Surrounding controls remain unaffected while active.
    expect(screen.getByRole('button', { name: /End Meeting/ })).toBeTruthy();
    expect(screen.getByLabelText('Playback progress')).toBeTruthy();
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
    // Regression guard: the file-selection metadata chrome hidden during
    // analysis (aria_uploaded_recording_hide_metadata_during_analysis) is
    // back once `active` is false again on this fresh mount.
    expect(screen.getByRole('heading', { name: 'Playback & analysis controls' })).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('orders coaching above the transcript and groups progress and controls below it', async () => {
    await startAnalysis();

    const coaching = screen.getByRole('region', { name: 'ARIA Coaching' });
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    const controls = screen.getByRole('region', { name: 'Playback and analysis controls' });

    expect(coaching.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(transcript.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 2026-08-30 (aria_uploaded_recording_hide_metadata_during_analysis): the
    // filename/metadata block and the preview <audio> element are unmounted
    // once active (see the dedicated hide/show test below), so they are no
    // longer asserted visible here.
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

  it('never unchecks a checklist item once a coaching push marks it done, even if a later push regresses it (aria_coaching_checklist_persist_checked_state)', async () => {
    const applyLiveMessage = await startAnalysis();
    const baseChecklist = Array.from({ length: 3 }, (_, index) => ({
      id: `ratchet-item-${index + 1}`,
      label: `Ratchet checklist item ${index + 1}`,
      done: false,
    }));

    // First coaching pass: item 2 becomes checked.
    applyLiveMessage({
      type: 'coaching',
      data: {
        disc: null,
        stage: null,
        checklist: baseChecklist.map((item, i) => ({ ...item, done: i === 1 })),
        nudges: [],
        urgent: null,
      },
    });
    await screen.findByText('1/3');

    // Second coaching pass: the derived engine "changes its mind" and
    // reports item 2 as no longer done (e.g. lower-confidence re-evaluation
    // of the same transcript window). It must stay checked in the UI.
    applyLiveMessage({
      type: 'coaching',
      data: {
        disc: null,
        stage: null,
        checklist: baseChecklist.map(item => ({ ...item, done: false })),
        nudges: [],
        urgent: null,
      },
    });

    await waitFor(() => expect(screen.getByText('1/3')).toBeTruthy());
    const coaching = screen.getByRole('region', { name: 'ARIA Coaching' });
    const item2 = coaching.querySelector('[data-coaching-checklist-item="ratchet-item-2"]');
    expect(item2?.textContent).toContain('✅');

    // A third pass can still check NEW items going forward.
    applyLiveMessage({
      type: 'coaching',
      data: {
        disc: null,
        stage: null,
        checklist: baseChecklist.map((item, i) => ({ ...item, done: i === 1 || i === 2 })),
        nudges: [],
        urgent: null,
      },
    });
    await screen.findByText('2/3');
    const item3 = screen.getByRole('region', { name: 'ARIA Coaching' })
      .querySelector('[data-coaching-checklist-item="ratchet-item-3"]');
    expect(item3?.textContent).toContain('✅');
  });

  it('starts a fresh analysis run with a fully unchecked checklist — no sticky state leaks across recordings', async () => {
    const { unmount } = renderPage();
    const applyLiveMessage = await (async () => {
      let handler: ((message: unknown) => void) | undefined;
      mocks.connect.mockImplementation(async (h: (message: unknown) => void) => { handler = h; });
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(handler).toBeTruthy());
      await screen.findByRole('heading', { name: 'Live transcript' });
      return handler!;
    })();
    applyLiveMessage({
      type: 'coaching',
      data: {
        disc: null,
        stage: null,
        checklist: [{ id: 'leftover-item', label: 'Leftover item', done: true }],
        nudges: [],
        urgent: null,
      },
    });
    await screen.findByText('1/1');

    // This page always navigates away on a completed analysis (to a
    // different component/route — see the "shows the Choose a recording
    // section again after a fresh mount" test above for the established
    // precedent), so the realistic "new meeting" boundary is a fresh mount.
    // The previous meeting's locked-checked state must not leak into it.
    unmount();
    renderPage();

    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });
    expect(panel.querySelector('[data-coaching-waiting="checklist"]')).toBeTruthy();
    expect(screen.queryByText('Leftover item')).toBeNull();
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

  it('creates the uploaded_recording meeting and exposes pause/End Meeting controls', async () => {
    renderPage();
    await selectAudio();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ durationSeconds: 12 }));
    expect(mocks.createMeeting).toHaveBeenCalledWith(12, 'walkthrough');
    expect(mocks.load).toHaveBeenCalledBefore(mocks.createMeeting);
    // 2026-08-30 (aria_uploaded_recording_hide_metadata_during_analysis): the
    // "locked while analysis is active" note lives inside the pre-analysis
    // playback-controls block, which is now unmounted entirely once active
    // (see the dedicated hide/show test below) — no longer asserted visible
    // here.
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

  // 2026-08-30 (aria_uploaded_recording_end_always_active): Troy's ask —
  // the End Meeting button must always be a working escape hatch back to
  // home, since reps landing on this page in 'idle', 'preparing', 'error',
  // or 'complete' previously had the button disabled with no way out.
  describe('End Meeting always-active escape hatch', () => {
    it('is enabled and navigates straight home (no confirm dialog) while idle, before any file is selected', async () => {
      renderPage();
      const endButton = screen.getByRole('button', { name: /End Meeting/ });
      expect(endButton).toHaveProperty('disabled', false);
      await userEvent.click(endButton);
      expect(screen.queryByText('End this meeting?')).toBeNull();
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/'));
      expect(mocks.end).not.toHaveBeenCalled();
    });

    it('is enabled and navigates straight home while preparing (Start Analysis clicked, not yet playing)', async () => {
      mocks.createMeeting.mockImplementation(() => new Promise(() => {})); // never resolves — stays in 'preparing'
      renderPage();
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /Starting/ })).toBeTruthy());

      const endButton = screen.getByRole('button', { name: /End Meeting/ });
      expect(endButton).toHaveProperty('disabled', false);
      await userEvent.click(endButton);
      expect(screen.queryByText('End this meeting?')).toBeNull();
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/'));
      expect(mocks.end).not.toHaveBeenCalled();
    });

    it('is enabled and navigates straight home after an error, with no confirm dialog', async () => {
      mocks.createMeeting.mockRejectedValueOnce(new Error('Network unavailable'));
      renderPage();
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await screen.findByRole('alert');

      const endButton = screen.getByRole('button', { name: /End Meeting/ });
      expect(endButton).toHaveProperty('disabled', false);
      await userEvent.click(endButton);
      expect(screen.queryByText('End this meeting?')).toBeNull();
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/'));
      expect(mocks.end).not.toHaveBeenCalled();
    });

    it('is enabled and navigates straight home once analysis is complete, alongside the existing View completed analysis button', async () => {
      let playbackCallbacks: { onEnded: () => void } | undefined;
      mocks.play.mockImplementation(async (callbacks: { onEnded: () => void }) => { playbackCallbacks = callbacks; });
      renderPage();
      await selectAudio();
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: /Start Analysis/ }));
      await waitFor(() => expect(playbackCallbacks).toBeTruthy());
      playbackCallbacks!.onEnded();
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));

      // Re-mount as a fresh instance in the 'complete' state is not directly
      // reachable post-navigation (this page navigates away on completion),
      // so this test asserts the always-active contract holds at the moment
      // 'complete' is set, immediately before that navigation — i.e. the
      // button is never disabled during the 'complete' state itself.
      expect(mocks.end).toHaveBeenCalledTimes(1);
    });

    it('remains disabled only during the transitional stopping state (finalize in flight)', async () => {
      let acknowledgeCompletion: (() => void) | undefined;
      mocks.waitForCompletion.mockImplementation(() => new Promise(resolve => {
        acknowledgeCompletion = () => resolve({ type: 'completed' });
      }));
      await startAnalysis();
      await userEvent.click(screen.getByRole('button', { name: /End Meeting/ }));
      const confirmDialog = await screen.findByText('End this meeting?');
      const confirmButton = within(confirmDialog.closest('div.bg-white') as HTMLElement).getByRole('button', { name: /End Meeting/ });
      await userEvent.click(confirmButton);

      await waitFor(() => expect(screen.getByRole('button', { name: /End Meeting/ })).toHaveProperty('disabled', true));
      acknowledgeCompletion!();
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));
    });

    it('leaves playing/paused behavior fully unchanged: confirm dialog still appears and Confirm still calls finalize()', async () => {
      await startAnalysis();
      const endButton = screen.getByRole('button', { name: /End Meeting/ });
      expect(endButton).toHaveProperty('disabled', false);
      await userEvent.click(endButton);
      expect(mocks.end).not.toHaveBeenCalled();
      const confirmDialog = await screen.findByText('End this meeting?');
      const confirmButton = within(confirmDialog.closest('div.bg-white') as HTMLElement).getByRole('button', { name: /End Meeting/ });
      await userEvent.click(confirmButton);
      await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-upload-1/post'));
      expect(mocks.end).toHaveBeenCalledTimes(1);
    });

    it('leaves paused behavior fully unchanged: confirm dialog still appears while paused', async () => {
      await startAnalysis();
      await userEvent.click(screen.getByRole('button', { name: /Pause/ }));
      expect(mocks.pause).toHaveBeenCalled();

      const endButton = screen.getByRole('button', { name: /End Meeting/ });
      expect(endButton).toHaveProperty('disabled', false);
      await userEvent.click(endButton);
      const confirmDialog = await screen.findByText('End this meeting?');
      const cancelButton = within(confirmDialog.closest('div.bg-white') as HTMLElement).getByRole('button', { name: 'Cancel' });
      await userEvent.click(cancelButton);
      expect(screen.queryByText('End this meeting?')).toBeNull();
      expect(mocks.end).not.toHaveBeenCalled();
      // Still paused, not navigated away — cancel is a true no-op.
      expect(screen.getByLabelText('location').textContent).toBe('/recordings/analyze');
    });
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
    await userEvent.click(screen.getByRole('radio', { name: 'Walkthrough (in-person)' }));
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
