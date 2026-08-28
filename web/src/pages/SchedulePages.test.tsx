// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ScheduleCallPage from './ScheduleCallPage';
import ScheduleVisitPage from './ScheduleVisitPage';

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../lib/api', () => ({ createScheduledMeeting: api.create }));
vi.mock('../components/AppHeader', () => ({ default: ({ title }: { title: string }) => <header>{title}</header> }));
function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }
function renderPage(path: string, element: React.ReactNode) { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path={path} element={<>{element}<Probe /></>} /><Route path="*" element={<Probe />} /></Routes></MemoryRouter>); }

beforeEach(() => { api.create.mockReset(); api.create.mockResolvedValue({ id: 'scheduled-1' }); });
afterEach(cleanup);
describe('schedule forms', () => {
  it('creates a future phone meeting with explicit Detroit timezone and identifying details', async () => {
    renderPage('/schedule/call', <ScheduleCallPage />);
    await userEvent.clear(screen.getByLabelText('Date and time'));
    await userEvent.type(screen.getByLabelText('Date and time'), '2026-08-29T10:30');
    await userEvent.type(screen.getByLabelText('Meeting title'), 'Follow-up call');
    await userEvent.type(screen.getByLabelText('Customer or contact name'), 'Jane Smith');
    await userEvent.type(screen.getByLabelText('Customer phone'), '6165551234');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule Meeting' }));
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'phone', timezone: 'America/Detroit', title: 'Follow-up call', customer_name: 'Jane Smith', customer_phone: '6165551234' }));
    expect(screen.getByLabelText('location').textContent).toBe('/');
  });

  it('creates an in-person visit and surfaces authenticated API validation failures', async () => {
    api.create.mockRejectedValue(new Error('Scheduled meetings must be in the future.'));
    renderPage('/schedule/visit', <ScheduleVisitPage />);
    await userEvent.type(screen.getByLabelText('Meeting title'), 'Estimate');
    await userEvent.type(screen.getByLabelText('Customer or contact name'), 'Jane');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule Meeting' }));
    expect((await screen.findByRole('alert')).textContent).toContain('future');
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'in_person', timezone: 'America/Detroit' }));
  });
});
