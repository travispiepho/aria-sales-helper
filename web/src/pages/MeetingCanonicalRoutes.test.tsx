// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MeetingRouteResolver from './MeetingRouteResolver';
import MeetingPage from './MeetingPage';
import BrowserCallControls from '../components/BrowserCallControls';

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
function fixture(status: 'active' | 'completed', channel: 'in_person' | 'phone' = 'in_person') {
  return { id: channel === 'phone' ? 'phone-1' : 'meeting-1', rep_id: 'rep-1', started_at: new Date().toISOString(), status, channel, call_sid: channel === 'phone' ? 'CA123' : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSegments.mockResolvedValue({ segments: [] });
  mocks.getLatestCoaching.mockResolvedValue({ coaching: null });
  call.state = 'ended';
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
