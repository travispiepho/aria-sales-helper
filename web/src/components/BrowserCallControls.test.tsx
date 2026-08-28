// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import BrowserCallControls from './BrowserCallControls';

const call = vi.hoisted(() => ({
  state: 'connected' as const,
  meetingId: 'meeting-live',
  muted: false,
  error: '',
  start: vi.fn(),
  toggleMute: vi.fn(),
  hangUp: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../lib/browserCall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/browserCall')>();
  return { ...actual, useBrowserCall: () => call };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BrowserCallControls', () => {
  it('renders compact live controls alongside, not over, transcript/coaching content', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hang Up' }));
    expect(call.toggleMute).toHaveBeenCalledOnce();
    expect(call.hangUp).toHaveBeenCalledOnce();
  });

  it('does not attach controls to a different meeting', () => {
    render(<MemoryRouter><BrowserCallControls meetingId="another-meeting" /></MemoryRouter>);
    expect(screen.queryByLabelText('Browser call controls')).toBeNull();
  });
});
