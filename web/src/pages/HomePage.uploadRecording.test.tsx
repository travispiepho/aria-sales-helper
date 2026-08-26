// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './HomePage';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }) }));
vi.mock('../lib/api', () => ({
  listMeetings: vi.fn(async () => ({ meetings: [], hasMore: false, limit: 20, offset: 0 })),
  createMeeting: vi.fn(), deleteMeeting: vi.fn(), getMeeting: vi.fn(), getMeetingSegments: vi.fn(), updateMeeting: vi.fn(),
}));
vi.mock('../components/CustomerIntakeModal', () => ({ default: () => null }));
vi.mock('../components/PhoneCallModal', () => ({ default: () => null }));
function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }

afterEach(cleanup);
describe('Home uploaded-recording action', () => {
  it('renders the fourth compact action and navigates to the authenticated upload route', async () => {
    render(<MemoryRouter initialEntries={['/']}><Routes>
      <Route path="/" element={<><HomePage /><Probe /></>} />
      <Route path="/recordings/analyze" element={<Probe />} />
    </Routes></MemoryRouter>);
    const action = await screen.findByRole('button', { name: '🎧 Analyze a Recording' });
    expect(action.className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: '▶ Record a Visit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '📞 Call a Customer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '🗓️ Schedule Ahead' })).toBeTruthy();
    await userEvent.click(action);
    expect(screen.getByLabelText('location').textContent).toBe('/recordings/analyze');
  });
});
