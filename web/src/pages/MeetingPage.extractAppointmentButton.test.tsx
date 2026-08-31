// @vitest-environment jsdom
//
// aria_setup_call_extract_appointment_button (2026-08-30)
//
// Covers: the "Extract Appointment Details" control renders ONLY on the
// post-meeting page for a real setup-call (Twilio phone, channel==='phone'
// && !!call_sid) meeting; NOT for in-person, NOT for an active/still-live
// meeting, and NOT for a non-Twilio (mobile local-mic) 'phone'-channel
// meeting with no call_sid. Also covers its positioning (renders before/
// above the "← Back to Home" button in DOM order) and its loading/success/
// error states.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MeetingPage from './MeetingPage';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  getSegments: vi.fn(),
  getLatestCoaching: vi.fn(),
  extractAppointmentDetails: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Rep' } }) }));
vi.mock('../lib/browserCall', () => ({
  useBrowserCall: () => ({
    state: 'idle', meetingId: null, muted: false, error: '',
    start: vi.fn(), toggleMute: vi.fn(), hangUp: vi.fn(), waitForTerminal: vi.fn(), clear: vi.fn(),
  }),
}));
vi.mock('../lib/api', () => ({
  getMeeting: mocks.getMeeting,
  getMeetingSegments: mocks.getSegments,
  getLatestCoaching: mocks.getLatestCoaching,
  getMeetingAnalytics: vi.fn(async () => { throw new Error('No analytics fixture'); }),
  getCoachingReport: vi.fn(async () => { throw new Error('No report fixture'); }),
  extractAppointmentDetails: mocks.extractAppointmentDetails,
  updateMeeting: vi.fn(),
  renameMeeting: vi.fn(),
  apiFetch: vi.fn(),
  dismissLibraryRebuttal: vi.fn(),
}));

const BASE_PHONE_MEETING = {
  id: 'meeting-phone-1',
  rep_id: 'rep-1',
  status: 'completed' as const,
  channel: 'phone' as const,
  call_sid: 'CA1234567890',
  origin_client: 'web' as const,
  is_owner_session: true,
  started_at: '2026-08-30T20:00:00.000Z',
  ended_at: '2026-08-30T20:06:00.000Z',
  speaker_labels: {},
  is_setup_call_mode: true,
};

const SEGMENTS = {
  segments: [{ id: 'segment-1', speaker: 'Rep', text: 'Does Thursday at 2pm work?', ts: '2026-08-30T20:01:00.000Z' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSegments.mockResolvedValue(SEGMENTS);
  mocks.getLatestCoaching.mockResolvedValue({ coaching: null });
});

afterEach(cleanup);

function renderMeeting(pageMode: 'active' | 'post') {
  render(
    <MemoryRouter initialEntries={['/meetings/meeting-phone-1']}>
      <Routes>
        <Route path="/meetings/:id" element={<MeetingPage meetingId="meeting-phone-1" pageMode={pageMode} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MeetingPage extract-appointment-details button gating', () => {
  it('renders for a post-meeting Twilio setup-call (phone + call_sid) meeting', async () => {
    mocks.getMeeting.mockResolvedValue(BASE_PHONE_MEETING);
    renderMeeting('post');

    expect(await screen.findByRole('button', { name: /Extract Appointment Details/i })).toBeTruthy();
  });

  it('does NOT render for a post-meeting in-person meeting', async () => {
    mocks.getMeeting.mockResolvedValue({
      ...BASE_PHONE_MEETING,
      channel: 'in_person',
      call_sid: undefined,
      is_setup_call_mode: false,
    });
    renderMeeting('post');

    await screen.findByRole('heading', { name: 'Transcript' });
    expect(screen.queryByRole('button', { name: /Extract Appointment Details/i })).toBeNull();
  });

  it('does NOT render for a post-meeting mobile local-mic phone-channel meeting (no call_sid)', async () => {
    mocks.getMeeting.mockResolvedValue({
      ...BASE_PHONE_MEETING,
      channel: 'phone',
      call_sid: null,
      is_setup_call_mode: false,
    });
    renderMeeting('post');

    await screen.findByRole('heading', { name: 'Transcript' });
    expect(screen.queryByRole('button', { name: /Extract Appointment Details/i })).toBeNull();
  });

  it('does NOT render on the active (still in-call) page for a setup call — post-meeting page only', async () => {
    mocks.getMeeting.mockResolvedValue({
      ...BASE_PHONE_MEETING,
      status: 'active',
      ended_at: undefined,
    });
    renderMeeting('active');

    await waitFor(() => expect(mocks.getMeeting).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Extract Appointment Details/i })).toBeNull();
  });

  it('does NOT render for a post-meeting uploaded-recording meeting', async () => {
    mocks.getMeeting.mockResolvedValue({
      ...BASE_PHONE_MEETING,
      channel: 'uploaded_recording',
      call_sid: undefined,
      is_setup_call_mode: false,
    });
    renderMeeting('post');

    await screen.findByRole('heading', { name: 'Transcript' });
    expect(screen.queryByRole('button', { name: /Extract Appointment Details/i })).toBeNull();
  });
});

describe('MeetingPage extract-appointment-details button positioning', () => {
  it('renders above (before, in DOM order) the "← Back to Home" button', async () => {
    mocks.getMeeting.mockResolvedValue(BASE_PHONE_MEETING);
    renderMeeting('post');

    const extractButton = await screen.findByRole('button', { name: /Extract Appointment Details/i });
    const backButton = await screen.findByRole('button', { name: '← Back to Home' });

    // DOCUMENT_POSITION_FOLLOWING (4) on backButton relative to extractButton
    // means extractButton comes first in document order, i.e. renders above it.
    const relativePosition = extractButton.compareDocumentPosition(backButton);
    // eslint-disable-next-line no-bitwise
    expect(!!(relativePosition & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });
});

describe('MeetingPage extract-appointment-details loading/success/error states', () => {
  it('shows a loading state while extracting, then renders the result card on success', async () => {
    mocks.getMeeting.mockResolvedValue(BASE_PHONE_MEETING);
    let resolveExtract: (value: unknown) => void;
    mocks.extractAppointmentDetails.mockReturnValue(new Promise((resolve) => { resolveExtract = resolve; }));

    renderMeeting('post');

    const button = await screen.findByRole('button', { name: /Extract Appointment Details/i });
    fireEvent.click(button);

    expect(await screen.findByRole('button', { name: /Extracting…/i })).toBeTruthy();

    resolveExtract!({
      mode: 'appointment_extraction',
      project_info: {
        customer_name: 'Jane Doe',
        customer_address: '456 Oak St',
        project_type: 'exterior repaint',
        scope_notes: null,
        approx_size_sqft: null,
        timeline_urgency: null,
        budget_signal: null,
        appointment_set: true,
        appointment_date_time: 'Thursday at 2pm',
        notes: null,
      },
    });

    await waitFor(() => expect(screen.getByText(/Thursday at 2pm/)).toBeTruthy());
    expect(screen.getByText('456 Oak St')).toBeTruthy();
    expect(screen.getByText('exterior repaint')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-extract/i })).toBeTruthy();
  });

  it('shows an error message when extraction fails', async () => {
    mocks.getMeeting.mockResolvedValue(BASE_PHONE_MEETING);
    mocks.extractAppointmentDetails.mockRejectedValue(new Error('Appointment extraction requires OPENROUTER_API_KEY.'));

    renderMeeting('post');

    const button = await screen.findByRole('button', { name: /Extract Appointment Details/i });
    fireEvent.click(button);

    expect(await screen.findByText('Appointment extraction requires OPENROUTER_API_KEY.')).toBeTruthy();
    // Button must return to its idle label, not get stuck on "Extracting…".
    expect(screen.getByRole('button', { name: /Extract Appointment Details/i })).toBeTruthy();
  });
});
