// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MeetingRouteResolver from './MeetingRouteResolver';
import MeetingPage from './MeetingPage';
import BrowserCallControls from '../components/BrowserCallControls';
import AppHeader, { AppNavigationVisibility } from '../components/AppHeader';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(), getSegments: vi.fn(), getLatestCoaching: vi.fn(), updateMeeting: vi.fn(),
}));
const call = vi.hoisted(() => ({
  state: 'ended' as 'ended' | 'connected', meetingId: 'phone-1', muted: false, error: '',
  start: vi.fn(), toggleMute: vi.fn(), hangUp: vi.fn(), waitForTerminal: vi.fn(), clear: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getMeeting: mocks.getMeeting,
  getMeetingSegments: mocks.getSegments,
  getLatestCoaching: mocks.getLatestCoaching,
  updateMeeting: mocks.updateMeeting,
  renameMeeting: vi.fn(),
  getCoachingReport: vi.fn(async () => { throw new Error('none'); }),
  getMeetingAnalytics: vi.fn(async () => { throw new Error('none'); }),
  apiFetch: vi.fn(),
  dismissLibraryRebuttal: vi.fn(),
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Test Rep' }, loading: false, logout: vi.fn() }),
}));
vi.mock('../lib/browserCall', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/browserCall')>()),
  useBrowserCall: () => call,
}));

function Probe() { return <span aria-label="location">{useLocation().pathname}</span>; }
function NavigationProbe() {
  const location = useLocation();
  return <><AppHeader title="Meeting" /><Probe key={location.pathname} /></>;
}
function fixture(status: 'active' | 'completed', channel: 'in_person' | 'phone' = 'in_person') {
  return { id: channel === 'phone' ? 'phone-1' : 'meeting-1', rep_id: 'rep-1', started_at: new Date().toISOString(), status, channel, call_sid: channel === 'phone' ? 'CA123' : null };
}

function expectThreeColumnActiveMeeting(typeLabel: string) {
  const workspace = document.querySelector('[data-active-meeting-layout="three-column"]');
  expect(workspace).toBeTruthy();
  const columns = Array.from(workspace!.querySelectorAll(':scope > [data-meeting-column]'));
  expect(columns.map(column => column.getAttribute('data-meeting-column'))).toEqual([
    'type',
    'feedback',
    'transcript',
  ]);
  expect(screen.getByRole('region', { name: typeLabel })).toBeTruthy();
  const right = screen.getByRole('region', { name: 'Speaker and transcript controls' });
  const rename = right.querySelector('[data-speaker-controls]')!;
  const transcript = right.querySelector('[data-live-transcript]')!;
  expect(rename.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSegments.mockResolvedValue({ segments: [] });
  mocks.getLatestCoaching.mockResolvedValue({ coaching: null });
  call.state = 'ended';
  call.meetingId = 'phone-1';
  call.waitForTerminal.mockResolvedValue('phone-1');
});
afterEach(cleanup);

describe('canonical meeting routes', () => {
  it('keeps an unstarted scheduled legacy deep link out of recording mode', async () => {
    mocks.getMeeting.mockResolvedValue({ id: 'scheduled-1', status: 'active', scheduled_for: '2030-01-01T15:00:00Z', scheduled_started_at: null });
    render(<MemoryRouter initialEntries={['/meetings/scheduled-1']}><Routes>
      <Route path="/meetings/:id" element={<MeetingRouteResolver />} />
      <Route path="*" element={<Probe />} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/schedule/scheduled-1/edit'));
  });

  it('restores shared navigation after the legacy resolver reaches post', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('completed'));
    render(<MemoryRouter initialEntries={['/meetings/meeting-1']}><Routes>
      <Route path="/meetings/:id" element={<MeetingRouteResolver />} />
      <Route path="/meetings/:id/post" element={<NavigationProbe />} />
    </Routes></MemoryRouter>);
    expect(await screen.findByRole('navigation', { name: 'Authenticated navigation' })).toBeTruthy();
  });

  it('keeps active navigation hidden after a legacy deep-link correction', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('active'));
    render(<MemoryRouter initialEntries={['/meetings/meeting-1']}><Routes>
      <Route path="/meetings/:id" element={<MeetingRouteResolver />} />
      <Route path="/meetings/:id/active" element={
        <AppNavigationVisibility visible={false}><NavigationProbe /></AppNavigationVisibility>
      } />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-1/active'));
    expect(screen.queryByRole('navigation', { name: 'Authenticated navigation' })).toBeNull();
  });

  it.each([
    ['active', '/meetings/meeting-1/active'],
    ['completed', '/meetings/meeting-1/post'],
  ] as const)('resolves a legacy deep link from authoritative %s state', async (status, destination) => {
    mocks.getMeeting.mockResolvedValue(fixture(status));
    render(<MemoryRouter initialEntries={['/meetings/meeting-1']}><Routes>
      <Route path="/meetings/:id" element={<MeetingRouteResolver />} />
      <Route path="*" element={<Probe />} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe(destination));
  });

  it.each([
    ['in-person', 'In-person meeting controls', 'meeting-1', 'in_person'],
    ['phone', 'Phone meeting controls', 'phone-1', 'phone'],
  ] as const)('renders the %s active meeting in the exact three-column structure', async (_name, label, id, channel) => {
    mocks.getMeeting.mockResolvedValue(fixture('active', channel));
    call.meetingId = 'other-browser-call';
    render(<MemoryRouter initialEntries={[`/meetings/${id}/active`]}><Routes>
      <Route path="/meetings/:id/active" element={<MeetingPage meetingId={id} pageMode="active" />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });
    expectThreeColumnActiveMeeting(label);
    const typeColumn = screen.getByRole('region', { name: label });
    if (channel === 'phone') {
      const browserControls = typeColumn.querySelector('[data-browser-call-controls]');
      browserControls?.remove();
      expect(typeColumn.textContent).toMatch(/Hang up your phone to end this meeting/i);
      expect(typeColumn.querySelector('button[data-meeting-end-control]')).toBeNull();
    } else {
      expect(typeColumn.querySelector('[data-meeting-end-control] button')).toBeTruthy();
      expect(typeColumn.textContent).toMatch(/Ready to record/i);
    }
  });

  it.each([
    ['owner in-person', { ...fixture('active', 'in_person'), is_owner_session: true }],
    ['owner phone', { ...fixture('active', 'phone'), is_owner_session: true, recording_status: 'in-progress' }],
    ['observer mobile sync', { ...fixture('active', 'in_person'), is_owner_session: false, origin_client: 'mobile' }],
  ] as const)('keeps %s status in the compact header without a dedicated top banner', async (_name, meeting) => {
    mocks.getMeeting.mockResolvedValue(meeting);
    call.meetingId = 'other-browser-call';
    render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
      <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
    </Routes></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Live Transcript' });
    const status = document.querySelector('[data-meeting-status-location="app-header"]');
    expect(status).toBeTruthy();
    expect(status!.closest('[data-app-header="compact"]')).toBeTruthy();
    expect(screen.queryByText('🔴 RECORDING — keep screen on')).toBeNull();
    expect(screen.queryByText('📱 LIVE — synced from mobile device')).toBeNull();
    if (meeting.is_owner_session === false) {
      expect(status!.textContent).toMatch(/^Synced from mobile · /);
      expect(screen.getByText('Live from phone')).toBeTruthy();
      expect(screen.getByText('Synced from mobile', { selector: '[data-meeting-column="type"] span' })).toBeTruthy();
    } else if (meeting.channel === 'phone') {
      expect(screen.getByText('Recording (Twilio)')).toBeTruthy();
      expect(screen.getByText('Call recording live')).toBeTruthy();
    } else {
      expect(status!.textContent).toMatch(/^Active · /);
      expect(screen.getByText('Ready to record')).toBeTruthy();
    }
  });

  it('moves End Meeting to post only after the terminal PATCH response', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('active'));
    mocks.updateMeeting.mockResolvedValue(fixture('completed'));
    render(<MemoryRouter initialEntries={['/meetings/meeting-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><MeetingPage meetingId="meeting-1" pageMode="active" /><Probe /></>} />
      <Route path="/meetings/:id/post" element={<Probe />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });
    screen.getByRole('button', { name: /End Meeting/ }).click();
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-1/post'));
  });

  it('does not redirect an active canonical URL when the server still says active', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('active'));
    render(<MemoryRouter initialEntries={['/meetings/meeting-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><MeetingPage meetingId="meeting-1" pageMode="active" /><Probe /></>} />
      <Route path="*" element={<Probe />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-1/active');
  });

  it('moves browser hangup to post only after authoritative terminal polling', async () => {
    let resolve!: (id: string) => void;
    call.waitForTerminal.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    render(<MemoryRouter initialEntries={['/meetings/phone-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><BrowserCallControls meetingId="phone-1" /><Probe /></>} />
      <Route path="/meetings/:id/post" element={<Probe />} />
    </Routes></MemoryRouter>);
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1/active');
    resolve('phone-1');
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1/post'));
  });

  it('keeps the phone call on the active page when completion cannot be proven', async () => {
    call.waitForTerminal.mockResolvedValue(null);
    render(<MemoryRouter initialEntries={['/meetings/phone-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><BrowserCallControls meetingId="phone-1" /><Probe /></>} />
      <Route path="/meetings/:id/post" element={<Probe />} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(call.waitForTerminal).toHaveBeenCalled());
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1/active');
  });
});
