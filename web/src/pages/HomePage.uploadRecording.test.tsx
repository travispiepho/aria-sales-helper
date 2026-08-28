// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './HomePage';

const mocks = vi.hoisted(() => ({ createMeeting: vi.fn(), updateMeeting: vi.fn(), listMeetings: vi.fn() }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }) }));
vi.mock('../lib/api', () => ({
  createMeeting: mocks.createMeeting,
  updateMeeting: mocks.updateMeeting,
  // Deliberately supplied so this test proves Home does not call history APIs.
  listMeetings: mocks.listMeetings,
}));
vi.mock('../components/CustomerIntakeModal', () => ({
  default: ({ onCreated }: { onCreated: (customerId: string, title: string) => void }) => (
    <button onClick={() => onCreated('customer-1', 'Kitchen Estimate')}>Submit intake</button>
  ),
}));
vi.mock('../components/PhoneCallModal', () => ({
  default: ({ onMeetingReady }: { onMeetingReady: (meetingId: string) => void }) => (
    <button onClick={() => onMeetingReady('phone-1')}>Phone ready</button>
  ),
}));
function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }

function renderHome() {
  return render(<MemoryRouter initialEntries={['/']}><Routes>
    <Route path="/" element={<><HomePage /><Probe /></>} />
    <Route path="*" element={<Probe />} />
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Home actions without meeting history', () => {
  it('retains all start, schedule, and upload actions without fetching or rendering history', async () => {
    renderHome();
    const recording = screen.getByRole('button', { name: '🎧 Analyze a Recording' });
    for (const action of [
      screen.getByRole('button', { name: '▶ Record a Visit' }),
      screen.getByRole('button', { name: '📞 Call a Customer' }),
      screen.getByRole('button', { name: '🗓️ Schedule Ahead' }),
      recording,
    ]) expect(action.className).toContain('min-h-11');

    expect(mocks.listMeetings).not.toHaveBeenCalled();
    expect(screen.queryByText("Today's Meetings")).toBeNull();
    expect(screen.queryByText('Previous Meetings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    await userEvent.click(recording);
    expect(screen.getByLabelText('location').textContent).toBe('/recordings/analyze');
  });

  it('retains schedule navigation', async () => {
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: '🗓️ Schedule Ahead' }));
    expect(screen.getByLabelText('location').textContent).toBe('/schedule');
  });

  it('retains customer intake creation and meeting-detail navigation', async () => {
    mocks.createMeeting.mockResolvedValue({ id: 'visit-1' });
    mocks.updateMeeting.mockResolvedValue({ id: 'visit-1' });
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: '▶ Record a Visit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit intake' }));
    expect(mocks.createMeeting).toHaveBeenCalledWith('customer-1');
    expect(mocks.updateMeeting).toHaveBeenCalledWith('visit-1', { title: 'Kitchen Estimate' });
    expect((await screen.findByLabelText('location')).textContent).toBe('/meetings/visit-1');
  });

  it('retains phone-call meeting-detail navigation', async () => {
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: '📞 Call a Customer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Phone ready' }));
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1');
  });
});
