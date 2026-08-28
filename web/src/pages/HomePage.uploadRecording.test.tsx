// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './HomePage';

const mocks = vi.hoisted(() => ({ createMeeting: vi.fn(), updateMeeting: vi.fn(), listMeetings: vi.fn(), listScheduledMeetings: vi.fn() }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }) }));
vi.mock('../lib/api', () => ({
  createMeeting: mocks.createMeeting,
  updateMeeting: mocks.updateMeeting,
  // Deliberately supplied so this test proves Home does not call history APIs.
  listMeetings: mocks.listMeetings,
  listScheduledMeetings: mocks.listScheduledMeetings,
  startScheduledMeeting: vi.fn(),
  cancelScheduledMeeting: vi.fn(),
}));
vi.mock('../components/CustomerIntakeModal', () => ({
  default: ({ onCreated }: { onCreated: (customerId: string, title: string) => void }) => (
    <button onClick={() => onCreated('customer-1', 'Kitchen Estimate')}>Submit intake</button>
  ),
}));
vi.mock('../components/PhoneCallModal', () => ({
  default: ({ onMeetingReady, initialCustomerPhone }: { onMeetingReady: (meetingId: string) => void; initialCustomerPhone?: string }) => (
    <button onClick={() => onMeetingReady('phone-1')}>Phone ready{initialCustomerPhone ? ` ${initialCustomerPhone}` : ''}</button>
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
beforeEach(() => { mocks.listScheduledMeetings.mockResolvedValue({ meetings: [] }); });
describe('Home actions without meeting history', () => {
  it('renders the first Home card after the shared navigation in normal flow', () => {
    const { container } = renderHome();
    const header = container.querySelector('[data-app-header="compact"]') as HTMLElement;
    const content = container.querySelector('[data-page-content]') as HTMLElement;
    const firstCard = screen.getByRole('heading', { name: 'Ready to meet?' }).parentElement as HTMLElement;

    expect(header.nextElementSibling).toBe(content);
    expect(content.firstElementChild).toBe(firstCard);
    expect(content.className).not.toMatch(/(?:^|\s)-mt-/);
    expect(firstCard.className).not.toMatch(/\babsolute\b/);
  });

  it('retains exactly four meeting choices and loads only the upcoming schedule below them', async () => {
    renderHome();
    const recording = screen.getByRole('button', { name: '🎧 Analyze a Recording' });
    for (const action of [
      screen.getByRole('button', { name: '▶ Record a Visit' }),
      screen.getByRole('button', { name: '📞 Call a Customer' }),
      screen.getByRole('button', { name: '🗓️ Schedule Ahead' }),
      recording,
    ]) expect(action.className).toContain('min-h-11');

    expect(screen.getAllByRole('button').filter((button) => ['▶ Record a Visit', '📞 Call a Customer', '🗓️ Schedule Ahead', '🎧 Analyze a Recording'].includes(button.textContent || ''))).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'Upcoming scheduled meetings' }).compareDocumentPosition(recording) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(mocks.listMeetings).not.toHaveBeenCalled();
    expect(mocks.listScheduledMeetings).toHaveBeenCalledTimes(1);
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
    expect((await screen.findByLabelText('location')).textContent).toBe('/meetings/visit-1/active');
  });

  it('retains phone-call meeting-detail navigation', async () => {
    renderHome();
    await userEvent.click(screen.getByRole('button', { name: '📞 Call a Customer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Phone ready' }));
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1/active');
  });
});
