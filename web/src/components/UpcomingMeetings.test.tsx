// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import UpcomingMeetings from './UpcomingMeetings';

const api = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock('../lib/api', () => ({
  listScheduledMeetings: api.list,
  startScheduledMeeting: api.start,
  cancelScheduledMeeting: api.cancel,
}));
vi.mock('./PhoneCallModal', () => ({ default: () => null }));
function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }
function meeting(id: string, scheduled_for: string) { return { id, title: id, status: 'active', channel: 'in_person', rep_id: 'rep-1', started_at: scheduled_for, scheduled_for, scheduled_customer_name: 'Jane' }; }
function renderList() { return render(<MemoryRouter><Routes><Route path="*" element={<><UpcomingMeetings /><Probe /></>} /></Routes></MemoryRouter>); }

beforeEach(() => { api.list.mockReset(); api.start.mockReset(); api.cancel.mockReset(); });
afterEach(cleanup);
describe('UpcomingMeetings', () => {
  it('renders authoritative order and starts the same record at its canonical active route', async () => {
    api.list.mockResolvedValue({ meetings: [meeting('first', '2026-08-29T13:00:00Z'), meeting('second', '2026-08-29T14:00:00Z')] });
    api.start.mockResolvedValue(meeting('first', '2026-08-29T13:00:00Z'));
    renderList();
    const articles = await screen.findAllByRole('article');
    expect(articles.map((node) => node.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('first'), expect.stringContaining('second')]));
    expect(articles[0].textContent).toContain('first');
    await userEvent.click(screen.getAllByRole('button', { name: 'Start' })[0]);
    expect(api.start).toHaveBeenCalledWith('first');
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/first/active'));
  });

  it('edits by deep link and removes a successfully cancelled item', async () => {
    api.list.mockResolvedValue({ meetings: [meeting('one', '2026-08-29T13:00:00Z')] });
    api.cancel.mockResolvedValue({});
    vi.stubGlobal('confirm', () => true);
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('location').textContent).toBe('/schedule/one/edit');
    cleanup();
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });
});
