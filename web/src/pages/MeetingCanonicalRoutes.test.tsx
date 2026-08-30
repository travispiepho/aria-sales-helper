// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MeetingRouteResolver from './MeetingRouteResolver';
import MeetingPage from './MeetingPage';
import BrowserCallControls from '../components/BrowserCallControls';
import AppHeader, { AppNavigationVisibility } from '../components/AppHeader';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(), getSegments: vi.fn(), getLatestCoaching: vi.fn(), updateMeeting: vi.fn(),
  getCustomer: vi.fn(), updateCustomer: vi.fn(),
}));
const call = vi.hoisted(() => ({
  state: 'ended' as 'ended' | 'connected' | 'idle', meetingId: 'phone-1' as string | null, muted: false, error: '',
  start: vi.fn(), toggleMute: vi.fn(), hangUp: vi.fn(), waitForTerminal: vi.fn(), clear: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getMeeting: mocks.getMeeting,
  getMeetingSegments: mocks.getSegments,
  getLatestCoaching: mocks.getLatestCoaching,
  updateMeeting: mocks.updateMeeting,
  getCustomer: mocks.getCustomer,
  updateCustomer: mocks.updateCustomer,
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
    const feedback = screen.getByRole('region', { name: 'ARIA Feedback' });
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });
    expect(feedback.contains(panel)).toBe(true);
    expect(Array.from(panel.querySelectorAll('[data-coaching-waiting]')).map(node => node.textContent)).toEqual([
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
      'Waiting on data...',
    ]);
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
  ] as const)('keeps %s status at the top of the left column, not a page-top app-header banner', async (_name, meeting) => {
    mocks.getMeeting.mockResolvedValue(meeting);
    call.meetingId = 'other-browser-call';
    render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
      <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
    </Routes></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Live Transcript' });
    // 2026-08-29 (aria_active_meeting_banner_info_left_panel): AppHeader is
    // not mounted at all during an active meeting — the status now lives
    // at the top of the left/"type" column instead.
    expect(document.querySelector('[data-app-header="compact"]')).toBeNull();
    const status = document.querySelector('[data-meeting-status-location="left-column"]');
    expect(status).toBeTruthy();
    const typeColumn = document.querySelector('[data-meeting-column="type"]');
    expect(typeColumn!.contains(status)).toBe(true);
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

  // 2026-08-29 (aria_left_panel_title_type_duration): title+type must now
  // render together on the block's first row, with the meeting duration
  // isolated on its own second row directly below — for all three meeting
  // types this page can render (in-person, rep-answered Twilio phone call,
  // and the observer/synced-from-mobile case, which is always in-person
  // channel-wise but renders the indigo tone + "Live from phone" pill).
  it.each([
    ['owner in-person', { ...fixture('active', 'in_person'), title: 'Smith Estimate', is_owner_session: true }, 'In-Person Meeting'],
    ['owner phone', { ...fixture('active', 'phone'), title: 'Jones Call', is_owner_session: true, recording_status: 'in-progress' }, 'Phone Call'],
  ['observer mobile sync', { ...fixture('active', 'in_person'), title: 'Lee Walkthrough', is_owner_session: false, origin_client: 'mobile' }, 'In-Person Meeting'],
  ] as const)('renders title+type together on row 1 and duration alone on row 2 for %s', async (_name, meeting, typeLabel) => {
    mocks.getMeeting.mockResolvedValue(meeting);
    call.meetingId = 'other-browser-call';
    render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
      <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });

    const typeColumn = document.querySelector('[data-meeting-column="type"]')!;
    const titleHeading = within(typeColumn as HTMLElement).getByRole('heading', { level: 1 });
    expect(titleHeading.textContent).toBe(meeting.title);

    const typeLabelEl = typeColumn.querySelector('[data-meeting-type-label="left-column"]');
    expect(typeLabelEl).toBeTruthy();
    expect(typeLabelEl!.textContent).toBe(typeLabel);
    // Title and its type label share row 1: same parent row container, and
    // the type label must not appear inside the duration row below it.
    expect(titleHeading.parentElement).toBe(typeLabelEl!.parentElement);

    const durationRow = typeColumn.querySelector('[data-meeting-status-location="left-column"]')!;
    expect(durationRow).toBeTruthy();
    // Duration row must be a sibling of (i.e. directly below) the title+type
    // row, not nested inside it, and must contain no type-label text.
    expect(durationRow.parentElement).toBe(titleHeading.parentElement!.parentElement);
    expect(durationRow.textContent).not.toContain(typeLabel);
    if (meeting.is_owner_session === false) {
      expect(durationRow.textContent).toMatch(/^Synced from mobile · \d+:\d{2}$/);
    } else if (meeting.channel === 'phone') {
      expect(durationRow.textContent).toMatch(/^(Active|Recording) · \d+:\d{2}$/);
    } else {
      expect(durationRow.textContent).toMatch(/^Active · \d+:\d{2}$/);
    }
  });

  // 2026-08-29 (aria_customer_info_editable_section): the new editable
  // Customer Info section must render directly under the title+type row /
  // duration row block above (same left column), for every meeting type
  // this page renders (in-person, phone). Also proves the no-customer-
  // linked case degrades gracefully instead of a broken/empty form.
  describe('Customer Info section placement and behavior', () => {
    it.each([
      ['in-person', { ...fixture('active', 'in_person'), customer_id: 'cust-1', customer_name: 'Jane Smith' }],
      ['phone', { ...fixture('active', 'phone'), customer_id: 'cust-1', customer_name: 'Jane Smith', recording_status: 'in-progress' }],
    ] as const)('renders under the title/duration rows for %s meetings', async (_name, meeting) => {
      mocks.getMeeting.mockResolvedValue(meeting);
      mocks.getCustomer.mockResolvedValue({
        id: 'cust-1', name: 'Jane Smith', address: '123 Main St', phone: '6165551212', email: 'jane@example.com', created_at: new Date().toISOString(),
      });
      call.meetingId = 'other-browser-call';
      render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
        <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
      </Routes></MemoryRouter>);
      await screen.findByRole('heading', { name: 'Live Transcript' });

      const typeColumn = document.querySelector('[data-meeting-column="type"]')!;
      const durationRow = typeColumn.querySelector('[data-meeting-status-location="left-column"]')!;
      const section = await within(typeColumn as HTMLElement).findByText('123 Main St');
      const sectionRoot = section.closest('[data-customer-info-section]')!;
      expect(sectionRoot).toBeTruthy();
      // The section must render AFTER (below) the title/duration block in
      // DOM order, i.e. directly under it, not above or detached elsewhere.
      expect(durationRow.compareDocumentPosition(sectionRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(sectionRoot as HTMLElement).getByText('Jane Smith')).toBeTruthy();
      expect(within(sectionRoot as HTMLElement).getByText('6165551212')).toBeTruthy();
      expect(within(sectionRoot as HTMLElement).getByText('jane@example.com')).toBeTruthy();
    });

    it('degrades gracefully (no crash, no broken empty section) when the meeting has no linked customer', async () => {
      const meeting = { ...fixture('active', 'in_person'), customer_id: undefined, customer_name: undefined };
      mocks.getMeeting.mockResolvedValue(meeting);
      call.meetingId = 'other-browser-call';
      render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
        <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
      </Routes></MemoryRouter>);
      await screen.findByRole('heading', { name: 'Live Transcript' });
      expect(mocks.getCustomer).not.toHaveBeenCalled();
      expect(document.querySelector('[data-customer-info-section="empty"]')).toBeTruthy();
      expect(screen.getByText('No customer linked to this meeting yet.')).toBeTruthy();
    });

    it('editing and saving a customer field calls updateCustomer and reflects the update live without a reload', async () => {
      const user = userEvent.setup();
      const meeting = { ...fixture('active', 'in_person'), customer_id: 'cust-1', customer_name: 'Jane Smith' };
      mocks.getMeeting.mockResolvedValue(meeting);
      mocks.getCustomer.mockResolvedValue({
        id: 'cust-1', name: 'Jane Smith', phone: '6165551212', created_at: new Date().toISOString(),
      });
      mocks.updateCustomer.mockResolvedValue({
        id: 'cust-1', name: 'Jane Smith', phone: '6165559999', created_at: new Date().toISOString(),
      });
      call.meetingId = 'other-browser-call';
      render(<MemoryRouter initialEntries={[`/meetings/${meeting.id}/active`]}><Routes>
        <Route path="/meetings/:id/active" element={<MeetingPage meetingId={meeting.id} pageMode="active" />} />
      </Routes></MemoryRouter>);
      await screen.findByRole('heading', { name: 'Live Transcript' });
      await screen.findByText('6165551212');

      await user.click(screen.getByRole('button', { name: '✏️ Edit' }));
      const phoneInput = screen.getByLabelText('Customer phone');
      await user.clear(phoneInput);
      await user.type(phoneInput, '6165559999');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mocks.updateCustomer).toHaveBeenCalledWith('cust-1', expect.objectContaining({ phone: '6165559999' })));
      // Reflected live in the UI (no reload/refetch needed).
      expect(await screen.findByText('6165559999')).toBeTruthy();
    });
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

  // 2026-08-29 (aria_browser_call_end_meeting_button): a browser call used
  // to render NO end control at all in this bottom-of-left-column position
  // (the `!isThisBrowserCall && isOwnerSession` skip) — ending only happened
  // via the now-removed BrowserCallControls Hang Up button. It now renders
  // the same shared EndMeetingButton as every other active meeting type,
  // and clicking it (after confirming, since the call is still live) both
  // hangs up the live Twilio Voice SDK call AND finalizes the meeting row
  // exactly like the in-person flow.
  it('renders a functional End Meeting button (not the phone Hang-Up status) for the active browser call, and clicking it hangs up the live call and finalizes the meeting', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('active', 'phone'));
    mocks.updateMeeting.mockResolvedValue(fixture('completed', 'phone'));
    call.state = 'connected';
    call.meetingId = 'phone-1';
    render(<MemoryRouter initialEntries={['/meetings/phone-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><MeetingPage meetingId="phone-1" pageMode="active" /><Probe /></>} />
      <Route path="/meetings/:id/post" element={<Probe />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });

    // No non-functional "Hang up your phone" status div for a browser call.
    expect(screen.queryByText(/Hang up your phone to end this meeting/i)).toBeNull();
    const endButton = screen.getByRole('button', { name: /End Meeting/ });
    expect(endButton.closest('[data-meeting-end-control]')).toBeTruthy();

    // The call is still live — clicking End Meeting confirms first, same as
    // an in-progress in-person recording, before actually ending anything.
    endButton.click();
    const confirmDialog = await screen.findByText('End this meeting?');
    expect(call.hangUp).not.toHaveBeenCalled();
    expect(mocks.updateMeeting).not.toHaveBeenCalled();
    const confirmButton = within(confirmDialog.closest('div.bg-white') as HTMLElement)
      .getByRole('button', { name: /End Meeting/ });
    confirmButton.click();

    await waitFor(() => expect(call.hangUp).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.updateMeeting).toHaveBeenCalledWith('phone-1', expect.objectContaining({ status: 'completed' })));
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/phone-1/post'));
  });

  it('does not call browserCall.hangUp when ending a non-browser-call meeting (regression: in-person and rep-answered Twilio phone calls unaffected)', async () => {
    mocks.getMeeting.mockResolvedValue(fixture('active'));
    mocks.updateMeeting.mockResolvedValue(fixture('completed'));
    call.state = 'idle';
    call.meetingId = null;
    render(<MemoryRouter initialEntries={['/meetings/meeting-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<><MeetingPage meetingId="meeting-1" pageMode="active" /><Probe /></>} />
      <Route path="/meetings/:id/post" element={<Probe />} />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });
    screen.getByRole('button', { name: /End Meeting/ }).click();
    await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/meetings/meeting-1/post'));
    expect(call.hangUp).not.toHaveBeenCalled();
  });

  it('keeps the rep-answered Twilio phone call\'s non-functional Hang-Up status unchanged when it is not this browser call', async () => {
    mocks.getMeeting.mockResolvedValue({ ...fixture('active', 'phone'), recording_status: 'in-progress' });
    call.state = 'idle';
    call.meetingId = 'other-browser-call';
    render(<MemoryRouter initialEntries={['/meetings/phone-1/active']}><Routes>
      <Route path="/meetings/:id/active" element={<MeetingPage meetingId="phone-1" pageMode="active" /> } />
    </Routes></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Live Transcript' });
    expect(screen.getByText(/Hang up your phone to end this meeting/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /End Meeting/ })).toBeNull();
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
