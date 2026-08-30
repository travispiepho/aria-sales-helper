// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import BrowserCallControls from './BrowserCallControls';

const call = vi.hoisted(() => ({
  state: 'connected' as 'connected' | 'ended',
  meetingId: 'meeting-live',
  muted: false,
  error: '',
  start: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  waitForTerminal: vi.fn(async () => null),
  clear: vi.fn(),
}));

vi.mock('../lib/browserCall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/browserCall')>();
  return { ...actual, useBrowserCall: () => call };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  call.state = 'connected';
});

describe('BrowserCallControls', () => {
  it('renders compact live status alongside, not over, transcript/coaching content, with no Mute/Hang Up controls', () => {
    render(
      <MemoryRouter><main>
        <BrowserCallControls meetingId="meeting-live" />
        <section aria-label="ARIA coaching">Coaching stays visible</section>
        <section aria-label="Live Transcript">Customer: Transcript stays visible</section>
      </main></MemoryRouter>
    );

    expect(screen.getByLabelText('Browser call controls')).toBeTruthy();
    expect(screen.getByLabelText('ARIA coaching')).toBeTruthy();
    expect(screen.getByLabelText('Live Transcript')).toBeTruthy();
    // 2026-08-29 (aria_browser_call_end_meeting_button): Mute and Hang Up are
    // removed from this component entirely — ending a browser call now
    // happens exclusively via MeetingPage's standard bottom-of-left-column
    // End Meeting button.
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unmute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hang Up' })).toBeNull();
    expect(call.toggleMute).not.toHaveBeenCalled();
    expect(call.hangUp).not.toHaveBeenCalled();
  });

  it('still shows Dismiss once the call has ended, with no Mute/Hang Up remnants', async () => {
    call.state = 'ended';
    render(<MemoryRouter><BrowserCallControls meetingId="meeting-live" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Call ended/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(call.clear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hang Up' })).toBeNull();
  });

  it('does not attach controls to a different meeting', () => {
    render(<MemoryRouter><BrowserCallControls meetingId="another-meeting" /></MemoryRouter>);
    expect(screen.queryByLabelText('Browser call controls')).toBeNull();
  });
});
