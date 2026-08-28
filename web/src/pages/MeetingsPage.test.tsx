// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MeetingsPage from './MeetingsPage';
import type { Meeting } from '../lib/api';

const mocks = vi.hoisted(() => ({
  listMeetings: vi.fn(),
  deleteMeeting: vi.fn(),
  getMeeting: vi.fn(),
  getMeetingSegments: vi.fn(),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera', role: 'admin' } }),
}));
vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  ...mocks,
}));

function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }

const today = new Date();
today.setHours(10, 0, 0, 0);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);

const todayMeeting: Meeting = {
  id: 'today-1', rep_id: 'rep-1', title: 'Exterior Estimate', customer_name: 'Avery Customer',
  rep_name: 'Gabe Rivera', started_at: today.toISOString(), ended_at: new Date(today.getTime() + 3_725_000).toISOString(), status: 'completed',
};
const previousMeeting: Meeting = {
  id: 'previous-1', rep_id: 'rep-2', customer_name: 'Previous Customer',
  rep_name: 'Admin Visible Rep', started_at: yesterday.toISOString(), status: 'interrupted',
};

function page(meetings: Meeting[], hasMore = false, offset = 0) {
  return { meetings, hasMore, limit: 20, offset };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/meetings']}>
      <Routes>
        <Route path="/meetings" element={<><MeetingsPage /><Probe /></>} />
        <Route path="/meetings/:id" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.listMeetings.mockResolvedValue(page([todayMeeting, previousMeeting], true));
  mocks.deleteMeeting.mockResolvedValue(undefined);
  mocks.getMeeting.mockResolvedValue({ ...todayMeeting, summary: 'Useful summary', speaker_labels: { speaker_0: 'Customer' } });
  mocks.getMeetingSegments.mockResolvedValue({ segments: [{ speaker: 'speaker_0', text: 'Hello', ts: today.toISOString() }] });
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
  URL.createObjectURL = vi.fn(() => 'blob:transcript');
  URL.revokeObjectURL = vi.fn();
});

describe('MeetingsPage', () => {
  it('loads and renders today/previous history, metadata, actions, and detail navigation', async () => {
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading meetings' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: "Today's Meetings" })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Previous Meetings' })).toBeTruthy();
    expect(screen.getByText('Exterior Estimate')).toBeTruthy();
    expect(screen.getByText('Customer: Avery Customer')).toBeTruthy();
    expect(screen.getByText('Rep: Gabe Rivera')).toBeTruthy();
    expect(screen.getByText('Previous Customer')).toBeTruthy();
    expect(screen.getByText('Rep: Admin Visible Rep')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('interrupted')).toBeTruthy();
    expect(screen.getByText(/1h 2m|62m 5s/)).toBeTruthy();
    expect(mocks.listMeetings).toHaveBeenCalledWith(0, 20);

    await userEvent.click(screen.getByRole('button', { name: 'Open meeting Exterior Estimate' }));
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/today-1');
  });

  it('paginates, de-duplicates, and exposes a retry when load more fails', async () => {
    const older = { ...previousMeeting, id: 'older-1', customer_name: 'Older Customer' };
    mocks.listMeetings
      .mockResolvedValueOnce(page([todayMeeting, previousMeeting], true))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([previousMeeting, older], false, 2));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load more meetings. Try again.");
    expect(screen.getByRole('button', { name: 'Retry load more' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry load more' }));
    expect(await screen.findByText('Older Customer')).toBeTruthy();
    expect(screen.getAllByText('Previous Customer')).toHaveLength(1);
    expect(mocks.listMeetings).toHaveBeenNthCalledWith(2, 2, 20);
    expect(mocks.listMeetings).toHaveBeenNthCalledWith(3, 2, 20);
  });

  it('confirms and deletes a meeting, and reports delete failures', async () => {
    mocks.deleteMeeting.mockRejectedValueOnce(new Error('Delete forbidden')).mockResolvedValueOnce(undefined);
    renderPage();
    await screen.findByText('Exterior Estimate');

    await userEvent.click(screen.getByRole('button', { name: 'Delete Exterior Estimate' }));
    expect(confirm).toHaveBeenCalledWith('Delete this meeting and its transcript? This cannot be undone.');
    expect(alert).toHaveBeenCalledWith('Delete forbidden');
    expect(screen.getByText('Exterior Estimate')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Delete Exterior Estimate' }));
    await waitFor(() => expect(screen.queryByText('Exterior Estimate')).toBeNull());
  });

  it('downloads the supported transcript export and reports download failures', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPage();
    await screen.findByText('Exterior Estimate');

    await userEvent.click(screen.getByRole('button', { name: 'Download transcript for Exterior Estimate' }));
    expect(mocks.getMeeting).toHaveBeenCalledWith('today-1');
    expect(mocks.getMeetingSegments).toHaveBeenCalledWith('today-1');
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:transcript');

    mocks.getMeeting.mockRejectedValueOnce(new Error('download failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Download transcript for Exterior Estimate' }));
    expect(alert).toHaveBeenCalledWith('Failed to download transcript');
    click.mockRestore();
  });

  it('distinguishes loading, initial failure with retry, empty, and no-today states', async () => {
    mocks.listMeetings.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
    renderPage();
    expect(await screen.findByText("Couldn't load your meetings")).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No meetings yet')).toBeTruthy();
    cleanup();

    mocks.listMeetings.mockResolvedValueOnce(page([previousMeeting]));
    renderPage();
    expect(await screen.findByText('No meetings yet today')).toBeTruthy();
    expect(screen.getByText('Previous Customer')).toBeTruthy();
  });

  it('does not open meeting details when an action control is used', async () => {
    renderPage();
    await screen.findByText('Exterior Estimate');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Exterior Estimate' }));
    await waitFor(() => expect(mocks.deleteMeeting).toHaveBeenCalled());
    expect(screen.getByLabelText('location').textContent).toBe('/meetings');
  });
});
