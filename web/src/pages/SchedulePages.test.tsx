// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import EditScheduledMeetingPage from './EditScheduledMeetingPage';
import ScheduleCallPage from './ScheduleCallPage';
import SchedulePage from './SchedulePage';
import ScheduleVisitPage from './ScheduleVisitPage';
import type { Meeting } from '../lib/api';

const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('../lib/api', () => ({
  createScheduledMeeting: api.create,
  getMeeting: api.get,
  updateScheduledMeeting: api.update,
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }),
}));

function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }
function renderPage(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path.replace('scheduled-1', ':id')} element={<>{element}<Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function scheduledMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'scheduled-1', rep_id: 'rep-1', started_at: '2026-08-29T14:30:00.000Z',
    status: 'active', channel: 'in_person', scheduled_for: '2026-08-29T14:30:00.000Z',
    scheduled_customer_name: 'Jane Smith', scheduled_customer_address: '123 Main St', title: 'Estimate',
    ...overrides,
  };
}

function expectNormalFlow(container: HTMLElement, firstContent: Element | null) {
  const layout = container.querySelector('[data-page-layout="flow"]') as HTMLElement;
  const header = container.querySelector('[data-app-header="compact"]') as HTMLElement;
  const navigation = screen.getByRole('navigation', { name: 'Authenticated navigation' });
  const content = container.querySelector('[data-page-content]') as HTMLElement;

  expect(layout.children[0]).toBe(header);
  expect(layout.children[1]).toBe(content);
  expect(header.contains(navigation)).toBe(true);
  expect(content.firstElementChild).toBe(firstContent);
  for (const element of [header, navigation, content, firstContent as HTMLElement]) {
    expect(element.className).not.toMatch(/\b(?:absolute|fixed|sticky)\b/);
  }
  expect(content.className).not.toMatch(/(?:^|\s)-mt-/);
  expect(content.className).toContain('pt-4');
}

beforeEach(() => {
  api.create.mockReset().mockResolvedValue(scheduledMeeting());
  api.get.mockReset().mockResolvedValue(scheduledMeeting());
  api.update.mockReset().mockResolvedValue(scheduledMeeting());
});
afterEach(cleanup);

describe('schedule route inventory and normal-flow layout', () => {
  it('keeps the entry/customer-selection screen below the shared navigation', () => {
    const { container } = renderPage('/schedule', <SchedulePage />);
    const firstCard = screen.getByRole('heading', { name: 'What are you scheduling?' }).parentElement;
    expectNormalFlow(container, firstCard);
    expect(screen.getByRole('button', { name: /Schedule a Call/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Schedule a Visit/ })).toBeTruthy();
  });

  it.each([
    ['/schedule/call', <ScheduleCallPage />, 'Customer phone'],
    ['/schedule/visit', <ScheduleVisitPage />, 'Visit address'],
  ])('keeps the date/time/details form for %s below the shared navigation', (path, page, subsetLabel) => {
    const { container } = renderPage(path as string, page);
    expectNormalFlow(container, screen.getByRole('form', { name: 'Scheduled meeting details' }));
    expect(screen.getByLabelText('Date and time')).toBeTruthy();
    expect(screen.getByLabelText('Meeting title')).toBeTruthy();
    expect(screen.getByLabelText('Customer or contact name')).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(subsetLabel as string))).toBeTruthy();
  });

  it('keeps the edit loading state and loaded details form below the shared navigation', async () => {
    let resolveMeeting!: (meeting: Meeting) => void;
    api.get.mockReturnValue(new Promise((resolve) => { resolveMeeting = resolve; }));
    const { container } = renderPage('/schedule/scheduled-1/edit', <EditScheduledMeetingPage />);
    expectNormalFlow(container, screen.getByRole('status', { name: 'Loading scheduled meeting' }));

    resolveMeeting(scheduledMeeting());
    expectNormalFlow(container, await screen.findByRole('form', { name: 'Scheduled meeting details' }));
    expect(screen.getByDisplayValue('Estimate')).toBeTruthy();
    expect(screen.getByDisplayValue('Jane Smith')).toBeTruthy();
  });

  it('keeps edit load errors below the shared navigation', async () => {
    api.get.mockRejectedValue(new Error('Could not load scheduled meeting.'));
    const { container } = renderPage('/schedule/scheduled-1/edit', <EditScheduledMeetingPage />);
    expectNormalFlow(container, await screen.findByRole('alert'));
  });
});

describe('schedule persistence behavior', () => {
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

  it('creates an in-person visit and keeps save validation errors in the in-flow form', async () => {
    api.create.mockRejectedValue(new Error('Scheduled meetings must be in the future.'));
    const { container } = renderPage('/schedule/visit', <ScheduleVisitPage />);
    await userEvent.type(screen.getByLabelText('Meeting title'), 'Estimate');
    await userEvent.type(screen.getByLabelText('Customer or contact name'), 'Jane');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule Meeting' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('future');
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'in_person', timezone: 'America/Detroit' }));
    expect(screen.getByRole('form', { name: 'Scheduled meeting details' }).contains(alert)).toBe(true);
    expectNormalFlow(container, screen.getByRole('form', { name: 'Scheduled meeting details' }));
  });

  it('edits the same scheduled record without changing its channel or timezone contract', async () => {
    api.get.mockResolvedValue(scheduledMeeting());
    renderPage('/schedule/scheduled-1/edit', <EditScheduledMeetingPage />);
    await userEvent.clear(await screen.findByLabelText('Meeting title'));
    await userEvent.type(screen.getByLabelText('Meeting title'), 'Updated estimate');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('scheduled-1', expect.objectContaining({
      channel: 'in_person', timezone: 'America/Detroit', title: 'Updated estimate',
    })));
    expect(screen.getByLabelText('location').textContent).toBe('/');
  });
});
