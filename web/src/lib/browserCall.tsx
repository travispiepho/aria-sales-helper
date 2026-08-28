import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Call, Device } from '@twilio/voice-sdk';
import { createBrowserCall, getBrowserCallStatus, getMeeting } from './api';
import { useAuth } from './auth';

export type BrowserCallState =
  | 'idle'
  | 'initializing'
  | 'dialing'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'error';

interface BrowserCallContextValue {
  state: BrowserCallState;
  meetingId: string | null;
  muted: boolean;
  error: string;
  start: (customerPhone: string) => Promise<string>;
  toggleMute: () => void;
  hangUp: () => void;
  waitForTerminal: () => Promise<string | null>;
  clear: () => void;
}

const BrowserCallContext = createContext<BrowserCallContextValue | null>(null);
const STORAGE_KEY = 'aria.browserCall.meetingId';
const BUSY_STATES: BrowserCallState[] = ['initializing', 'dialing', 'ringing', 'connecting', 'connected'];

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : 'Browser calling is unavailable';
}

export function browserCallStatusLabel(state: BrowserCallState, muted: boolean): string {
  const labels: Record<BrowserCallState, string> = {
    idle: 'Ready to call from this browser',
    initializing: 'Initializing secure browser calling…',
    dialing: 'Dialing…',
    ringing: 'Customer phone is ringing…',
    connecting: 'Connecting…',
    connected: muted ? 'Connected · Muted' : 'Connected',
    ended: 'Call ended',
    error: 'Call error',
  };
  return labels[state];
}

export function BrowserCallProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const recoveredMeetingId = typeof window !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
  const [state, setState] = useState<BrowserCallState>(recoveredMeetingId ? 'ended' : 'idle');
  const [meetingId, setMeetingId] = useState<string | null>(recoveredMeetingId);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(recoveredMeetingId ? 'The browser call disconnected when this page reloaded.' : '');
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const generationRef = useRef(0);

  const cleanupSdk = useCallback(() => {
    generationRef.current += 1;
    const call = callRef.current;
    callRef.current = null;
    if (call) {
      call.removeAllListeners();
      if (call.status() !== Call.State.Closed) call.disconnect();
    }
    const device = deviceRef.current;
    deviceRef.current = null;
    if (device) {
      device.removeAllListeners();
      device.destroy();
    }
  }, []);

  const clear = useCallback(() => {
    cleanupSdk();
    sessionStorage.removeItem(STORAGE_KEY);
    setMeetingId(null);
    setMuted(false);
    setError('');
    setState('idle');
  }, [cleanupSdk]);

  useEffect(() => () => cleanupSdk(), [cleanupSdk]);
  useEffect(() => { if (!loading && !user) clear(); }, [loading, user, clear]);

  const waitForMeeting = useCallback(async (pendingCallId: string, generation: number) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && generationRef.current === generation) {
      const status = await getBrowserCallStatus(pendingCallId);
      if (status.error) throw new Error(status.error);
      if (status.meetingId) return status.meetingId;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('The call started, but the meeting screen could not be opened. Hang up and try again.');
  }, []);

  const start = useCallback(async (customerPhone: string) => {
    if (BUSY_STATES.includes(state)) throw new Error('A browser call is already in progress');
    cleanupSdk();
    sessionStorage.removeItem(STORAGE_KEY);
    setMeetingId(null);
    setMuted(false);
    setError('');
    setState('initializing');
    const generation = generationRef.current;

    try {
      const setup = await createBrowserCall(customerPhone);
      if (generationRef.current !== generation) throw new Error('Call cancelled');
      const device = new Device(setup.token, { appName: 'ARIA Web', appVersion: '1.0.0', logLevel: 4 });
      deviceRef.current = device;
      device.on('error', (sdkError) => {
        if (generationRef.current !== generation) return;
        setError(sdkError.message || 'Browser calling error');
        setState('error');
      });

      setState('dialing');
      const call = await device.connect({
        params: { pendingCallId: setup.pendingCallId },
        rtcConstraints: { audio: true },
      });
      if (generationRef.current !== generation) {
        call.disconnect();
        throw new Error('Call cancelled');
      }
      callRef.current = call;
      setState('connecting');
      call.on('ringing', () => generationRef.current === generation && setState('ringing'));
      call.on('accept', () => generationRef.current === generation && setState('connected'));
      call.on('disconnect', () => generationRef.current === generation && setState('ended'));
      call.on('cancel', () => generationRef.current === generation && setState('ended'));
      call.on('reject', () => generationRef.current === generation && setState('ended'));
      call.on('mute', (isMuted) => generationRef.current === generation && setMuted(isMuted));
      call.on('error', (sdkError) => {
        if (generationRef.current !== generation) return;
        setError(sdkError.message || 'Call failed');
        setState('error');
      });

      const id = await waitForMeeting(setup.pendingCallId, generation);
      if (generationRef.current !== generation) throw new Error('Call cancelled');
      setMeetingId(id);
      sessionStorage.setItem(STORAGE_KEY, id);
      return id;
    } catch (err) {
      if (generationRef.current === generation) {
        cleanupSdk();
        setError(messageFromError(err));
        setState('error');
      }
      throw err;
    }
  }, [state, cleanupSdk, waitForMeeting]);

  const toggleMute = useCallback(() => {
    if (!callRef.current || state !== 'connected') return;
    callRef.current.mute(!muted);
  }, [muted, state]);

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
    setState('ended');
  }, []);

  const waitForTerminal = useCallback(async () => {
    const id = meetingId;
    if (!id) return null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const latest = await getMeeting(id);
        if (latest.status !== 'active') return id;
      } catch {
        // A transient read failure cannot prove completion. Keep reconciling
        // until a terminal server row is observed or the bounded wait ends.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
  }, [meetingId]);

  return (
    <BrowserCallContext.Provider value={{ state, meetingId, muted, error, start, toggleMute, hangUp, waitForTerminal, clear }}>
      {children}
    </BrowserCallContext.Provider>
  );
}

export function useBrowserCall(): BrowserCallContextValue {
  const value = useContext(BrowserCallContext);
  if (!value) throw new Error('useBrowserCall must be used inside BrowserCallProvider');
  return value;
}
