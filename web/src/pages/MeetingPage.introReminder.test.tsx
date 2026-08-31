// @vitest-environment jsdom
//
// aria_rep_auto_naming_transcript_labels (2026-08-30): coverage for the new
// "introduce yourself" reminder shown to the rep at the start of an
// in-person meeting, additive to the existing recording-consent modal. The
// reminder exists so ARIA's self-introduction detector (see
// server/inPersonIntroductionLabels.js) has something to latch onto — it is
// UI-only guidance, not new backend logic.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MeetingPage from './MeetingPage';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  getSegments: vi.fn(),
  getLatestCoaching: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Ada' } }) }));
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
  updateMeeting: vi.fn(),
  renameMeeting: vi.fn(),
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  dismissLibraryRebuttal: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMeeting.mockResolvedValue({
    id: 'meeting-1',
    rep_id: 'rep-1',
    status: 'active',
    channel: 'in_person',
    call_sid: null,
    origin_client: 'web',
    is_owner_session: true,
    started_at: new Date().toISOString(),
    speaker_labels: {},
  });
  mocks.getSegments.mockResolvedValue({ segments: [] });
  mocks.getLatestCoaching.mockResolvedValue({ coaching: null });
});

afterEach(cleanup);

function renderActiveMeeting() {
  render(
    <MemoryRouter initialEntries={['/meetings/meeting-1/active']}>
      <Routes>
        <Route path="/meetings/:id/active" element={<MeetingPage meetingId="meeting-1" pageMode="active" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('in-person meeting introduce-yourself reminder', () => {
  it('shows the introduce-yourself reminder inside the recording-consent modal, not before it', async () => {
    const user = userEvent.setup();
    renderActiveMeeting();

    const recordButton = await screen.findByRole('button', { name: /Record/i });
    expect(screen.queryByText(/Introduce yourself by name/i)).toBeNull();

    await user.click(recordButton);

    expect(await screen.findByRole('heading', { name: 'Consent Required' })).toBeTruthy();
    expect(screen.getByText(/Introduce yourself by name/i)).toBeTruthy();
  });
});
