// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import PhoneCallModal from './PhoneCallModal';
import { BrowserCallProvider } from '../lib/browserCall';

const api = vi.hoisted(() => ({
  createBrowserCall: vi.fn(),
  getBrowserCallStatus: vi.fn(),
  startOutboundCall: vi.fn(),
}));

class FakeCall {
  static State = { Closed: 'closed' };
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  disconnected = false;
  muted = false;
  on(event: string, fn: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]) { for (const fn of this.listeners.get(event) || []) fn(...args); }
  removeAllListeners() { this.listeners.clear(); }
  status() { return this.disconnected ? 'closed' : 'connecting'; }
  disconnect() { this.disconnected = true; this.emit('disconnect'); }
  mute(value: boolean) { this.muted = value; this.emit('mute', value); }
}

const voice = vi.hoisted(() => {
  class HoistedFakeCall {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    disconnected = false;
    muted = false;
    on(event: string, fn: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) || []), fn]); return this; }
    emit(event: string, ...args: unknown[]) { for (const fn of this.listeners.get(event) || []) fn(...args); }
    removeAllListeners() { this.listeners.clear(); }
    status() { return this.disconnected ? 'closed' : 'connecting'; }
    disconnect() { this.disconnected = true; this.emit('disconnect'); }
    mute(value: boolean) { this.muted = value; this.emit('mute', value); }
  }
  const state: { call: HoistedFakeCall | null; device: FakeDevice | null } = { call: null, device: null };
  class FakeDevice {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    destroyed = false;
    connect = vi.fn(async (options: unknown) => {
      state.call = new HoistedFakeCall();
      (state.call as HoistedFakeCall & { connectOptions?: unknown }).connectOptions = options;
      return state.call;
    });
    constructor(_token: string) { state.device = this; }
    on(event: string, fn: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) || []), fn]); return this; }
    removeAllListeners() { this.listeners.clear(); }
    destroy() { this.destroyed = true; }
  }
  return { state, FakeDevice, HoistedFakeCall };
});

vi.mock('../lib/api', () => api);
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'rep-1', phone: '+16165550111' } }) }));
vi.mock('@twilio/voice-sdk', () => ({
  Device: voice.FakeDevice,
  Call: { State: { Closed: 'closed' } },
}));

function renderModal(onClose = vi.fn(), props: { initialCustomerPhone?: string; scheduledMeetingId?: string } = {}) {
  const onMeetingReady = vi.fn();
  return {
    ...render(
      <BrowserCallProvider>
        <PhoneCallModal onClose={onClose} onMeetingReady={onMeetingReady} {...props} />
      </BrowserCallProvider>
    ),
    onClose,
    onMeetingReady,
  };
}

async function enterCustomerAndCall() {
  await userEvent.type(screen.getByLabelText("Customer's Phone Number"), '6165550123');
  await userEvent.click(screen.getByRole('button', { name: 'Call from Browser' }));
  await waitFor(() => expect(voice.state.device?.connect).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  voice.state.call = null;
  voice.state.device = null;
  api.createBrowserCall.mockResolvedValue({ browserCalling: true, token: 'secret-jwt', pendingCallId: 'pending-123', expiresIn: 300 });
  api.getBrowserCallStatus.mockResolvedValue({ meetingId: 'meeting-browser-1', error: null });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('PhoneCallModal browser calling', () => {
  it('defaults to browser mode with customer field only and sends only opaque pendingCallId to Twilio', async () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Call from Browser' })).toBeTruthy();
    expect(screen.queryByLabelText('Your Phone Number')).toBeNull();
    await enterCustomerAndCall();
    expect(api.createBrowserCall).toHaveBeenCalledWith('6165550123');
    expect(voice.state.device?.connect).toHaveBeenCalledWith({ params: { pendingCallId: 'pending-123' }, rtcConstraints: { audio: true } });
  });

  it('prefills and binds a scheduled call to the existing scheduled record', async () => {
    renderModal(vi.fn(), { initialCustomerPhone: '6165559999', scheduledMeetingId: 'scheduled-1' });
    expect((screen.getByLabelText("Customer's Phone Number") as HTMLInputElement).value).toBe('6165559999');
    expect(screen.queryByRole('button', { name: 'Use My Phone Instead' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Call from Browser' }));
    await waitFor(() => expect(api.createBrowserCall).toHaveBeenCalledWith('6165559999', 'scheduled-1'));
  });

  it('shows ringing/connected state and supports mute and hang up', async () => {
    renderModal();
    await enterCustomerAndCall();
    voice.state.call?.emit('ringing', false);
    expect(await screen.findByText('Customer phone is ringing…')).toBeTruthy();
    voice.state.call?.emit('accept');
    expect(await screen.findByText('Connected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(voice.state.call?.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Hang Up' }));
    expect(voice.state.call?.disconnected).toBe(true);
    expect(await screen.findByText('Call ended')).toBeTruthy();
  });

  it('hands the server-created meeting ID to routing without disconnecting the SDK call', async () => {
    const { onMeetingReady } = renderModal();
    await enterCustomerAndCall();
    await waitFor(() => expect(onMeetingReady).toHaveBeenCalledWith('meeting-browser-1'));
    expect(voice.state.call?.disconnected).toBe(false);
  });

  it('falls back visibly when token/setup is disabled or unavailable', async () => {
    api.createBrowserCall.mockRejectedValue(new Error('Browser calling is disabled'));
    renderModal();
    await userEvent.type(screen.getByLabelText("Customer's Phone Number"), '6165550123');
    await userEvent.click(screen.getByRole('button', { name: 'Call from Browser' }));
    expect(await screen.findByLabelText('Your Phone Number')).toBeTruthy();
    expect(screen.getByText(/You can still call using your phone/)).toBeTruthy();
  });

  it('keeps existing rep-phone fallback and only shows rep field in that mode', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Use My Phone Instead' }));
    expect(screen.getByLabelText('Your Phone Number')).toBeTruthy();
    expect(screen.getByLabelText('Your Phone Number')).toHaveProperty('value', '+16165550111');
    expect(screen.queryByRole('button', { name: 'Call from Browser' })).toBeNull();
  });

  it('cleans up and disconnects on close/unmount', async () => {
    const { unmount } = renderModal();
    await enterCustomerAndCall();
    const call = voice.state.call;
    const device = voice.state.device;
    unmount();
    expect(call?.disconnected).toBe(true);
    expect(device?.destroyed).toBe(true);
  });

  it('surfaces call errors', async () => {
    renderModal();
    await enterCustomerAndCall();
    voice.state.call?.emit('error', new Error('WebRTC failed'));
    expect(await screen.findByText('WebRTC failed')).toBeTruthy();
    expect(screen.getByText('Call error')).toBeTruthy();
  });
});
