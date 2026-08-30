// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MeetingPage from './MeetingPage';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  getSegments: vi.fn(),
  getLatestCoaching: vi.fn(),
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
  updateMeeting: vi.fn(),
  renameMeeting: vi.fn(),
  apiFetch: vi.fn(),
  dismissLibraryRebuttal: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  renderMode = 'post';
  mocks.getMeeting.mockResolvedValue({
    id: 'meeting-upload-1',
    rep_id: 'rep-1',
    status: 'completed',
    channel: 'uploaded_recording',
    origin_client: 'web',
    is_owner_session: true,
    started_at: '2026-08-27T20:00:00.000Z',
    ended_at: '2026-08-27T20:12:00.000Z',
    summary: 'Completed uploaded recording summary.',
    speaker_labels: {},
  });
  mocks.getSegments.mockResolvedValue({
    segments: [{
      id: 'segment-1', speaker: 'Speaker 1', text: 'Uploaded transcript row.',
      ts: '2026-08-27T20:01:00.000Z',
    }],
  });
  mocks.getLatestCoaching.mockResolvedValue({ coaching: null });
});

afterEach(cleanup);

let renderMode: 'active' | 'post' = 'post';

function renderMeeting() {
  render(
    <MemoryRouter initialEntries={['/meetings/meeting-upload-1']}>
      <Routes>
        <Route path="/meetings/:id" element={<MeetingPage meetingId="meeting-upload-1" pageMode={renderMode} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MeetingPage completed uploaded recording', () => {
  it('renders the same post-meeting analysis/details branch as End Meeting, with no recording-start controls', async () => {
    renderMeeting();

    expect(await screen.findByText('Completed uploaded recording summary.')).toBeTruthy();
    expect(screen.getByText('Uploaded transcript row.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Meeting Summary' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText(/^Completed ·/)).toBeTruthy();

    expect(screen.queryByRole('button', { name: /^Record$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Start Recording|Start Meeting/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /End Meeting/i })).toBeNull();
    expect(screen.queryByText(/Start recording to see live transcript/i)).toBeNull();
    expect(screen.getByRole('button', { name: '← Back to Home' })).toBeTruthy();
  });
});

describe('MeetingPage Google Docs export visibility', () => {
  it.each([
    ['active', 'in_person'],
    ['active', 'phone'],
    ['active', 'uploaded_recording'],
    ['completed', 'in_person'],
    ['completed', 'phone'],
    ['completed', 'uploaded_recording'],
  ] as const)('does not render an export control for a %s %s meeting', async (status, channel) => {
    mocks.getMeeting.mockResolvedValue({
      id: 'meeting-upload-1',
      rep_id: 'rep-1',
      status,
      channel,
      origin_client: 'web',
      is_owner_session: true,
      started_at: '2026-08-27T20:00:00.000Z',
      ended_at: status === 'completed' ? '2026-08-27T20:12:00.000Z' : undefined,
      summary: 'Completed uploaded recording summary.',
      speaker_labels: {},
    });

    renderMode = status === 'active' ? 'active' : 'post';
    renderMeeting();

    expect(await screen.findByRole('heading', {
      name: status === 'active' ? 'Live Transcript' : 'Transcript',
    })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /export.*google|google.*doc/i })).toBeNull();
    expect(screen.queryByText(/export.*google|google.*doc/i)).toBeNull();
  });
});

// aria_coaching_left_panel_space_between_layout (2026-08-30): the left
// ("type") column of an ACTIVE in-person/phone meeting relies on
// `.active-meeting-type-column`'s `justify-content: space-between`
// (index.css) so its top-level children (title/status block, the scrollable
// content wrapper, and the bottom End Meeting control) pin top/bottom with
// evenly distributed space in between, instead of a purely fixed gap.
describe('MeetingPage active left column layout', () => {
  it('applies the space-between left-column class to the active type column', async () => {
    mocks.getMeeting.mockResolvedValue({
      id: 'meeting-active-1',
      rep_id: 'rep-1',
      status: 'active',
      channel: 'in_person',
      origin_client: 'web',
      is_owner_session: true,
      started_at: '2026-08-27T20:00:00.000Z',
      speaker_labels: {},
    });
    renderMode = 'active';
    renderMeeting();

    const typeColumn = await screen.findByRole('region', { name: 'In-person meeting controls' });
    expect(typeColumn.className).toContain('active-meeting-type-column');
  });
});
