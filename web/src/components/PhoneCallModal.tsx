import React, { useState } from 'react';
import { startOutboundCall } from '../lib/api';
import { useAuth } from '../lib/auth';
import { browserCallStatusLabel, useBrowserCall } from '../lib/browserCall';

interface Props {
  onClose: () => void;
  onMeetingReady: (meetingId: string) => void;
  initialCustomerPhone?: string;
  scheduledMeetingId?: string;
}

type Mode = 'browser' | 'phone';
type PhoneState = 'idle' | 'placing' | 'ringing-rep' | 'failed';

function looksLikePhoneNumber(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const digitsOnly = trimmed.replace(/^\+/, '').replace(/[\s().-]/g, '');
  return /^\d{10,15}$/.test(digitsOnly);
}

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : 'Browser calling is unavailable';
}

export default function PhoneCallModal({ onClose, onMeetingReady, initialCustomerPhone = '', scheduledMeetingId }: Props) {
  const { user } = useAuth();
  const [mode, setMode] = useState<Mode>('browser');
  const [repPhone, setRepPhone] = useState(user?.phone || '');
  const [customerPhone, setCustomerPhone] = useState(initialCustomerPhone);
  const [repPhoneError, setRepPhoneError] = useState('');
  const [customerPhoneError, setCustomerPhoneError] = useState('');
  const [phoneState, setPhoneState] = useState<PhoneState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const browserCall = useBrowserCall();
  const browserState = browserCall.state;
  const muted = browserCall.muted;

  const browserBusy = ['initializing', 'dialing', 'ringing', 'connecting', 'connected'].includes(browserState);
  const phoneBusy = phoneState === 'placing' || phoneState === 'ringing-rep';
  const busy = browserBusy || phoneBusy;

  function validateCustomer(): boolean {
    if (!looksLikePhoneNumber(customerPhone)) {
      setCustomerPhoneError('Enter a valid phone number, e.g. (616) 555-1234');
      return false;
    }
    setCustomerPhoneError('');
    return true;
  }

  function usePhoneFallback(reason?: string) {
    browserCall.clear();
    setMode('phone');
    if (reason) setErrorMsg(`${reason} You can still call using your phone.`);
  }

  async function handleBrowserCall(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (!validateCustomer()) return;

    try {
      const meetingId = await browserCall.start(customerPhone.trim(), scheduledMeetingId);
      onMeetingReady(meetingId);
    } catch (err) {
      if (scheduledMeetingId) {
        setErrorMsg(`${messageFromError(err)} The scheduled meeting was not started.`);
      } else {
        usePhoneFallback(messageFromError(err));
      }
    }
  }

  async function handlePhoneCall(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    let ok = validateCustomer();
    if (!looksLikePhoneNumber(repPhone)) {
      setRepPhoneError('Enter a valid phone number, e.g. (616) 555-1234');
      ok = false;
    } else setRepPhoneError('');
    if (!ok) return;

    setPhoneState('placing');
    try {
      const result = await startOutboundCall(repPhone.trim(), customerPhone.trim(), undefined, scheduledMeetingId);
      setPhoneState('ringing-rep');
      if (result.meetingId) onMeetingReady(result.meetingId);
    } catch (err) {
      setPhoneState('failed');
      setErrorMsg(messageFromError(err));
    }
  }

  function hangUp() {
    browserCall.hangUp();
  }

  function toggleMute() {
    browserCall.toggleMute();
  }

  function close() {
    browserCall.clear();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={busy ? undefined : close} />
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 pt-5 pb-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Call a Customer</h2>
          {!busy && <button onClick={close} aria-label="Close" className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>}
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex gap-3">
            <span className="text-lg leading-none">⏺️</span>
            <p className="text-sm text-amber-900">
              This call will be recorded. A recorded message plays before the customer is connected letting them know the call is recorded.
            </p>
          </div>

          {(errorMsg || browserCall.error) && (
            <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">
              {errorMsg || browserCall.error}
            </div>
          )}

          {mode === 'browser' ? (
            <form onSubmit={handleBrowserCall} className="space-y-4">
              <div>
                <label htmlFor="browser-customer-phone" className="block text-sm font-medium text-gray-700 mb-1">Customer's Phone Number</label>
                <input
                  id="browser-customer-phone"
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  disabled={browserBusy}
                  placeholder="(616) 555-6789"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
                />
                {customerPhoneError && <p className="text-xs text-red-600 mt-1">{customerPhoneError}</p>}
              </div>

              <div role="status" className="rounded-xl bg-blue-50 text-blue-900 px-4 py-3 text-sm">{browserCallStatusLabel(browserState, muted)}</div>

              {browserState === 'connected' ? (
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={toggleMute} className="border border-gray-300 font-semibold py-3 rounded-xl">
                    {muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button type="button" onClick={hangUp} className="bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Hang Up</button>
                </div>
              ) : browserBusy ? (
                <button type="button" onClick={hangUp} className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Hang Up</button>
              ) : (
                <button type="submit" className="w-full bg-brand-700 hover:bg-brand-800 text-white font-semibold py-4 rounded-xl text-lg">Call from Browser</button>
              )}

              {!scheduledMeetingId && <button type="button" disabled={browserBusy} onClick={() => usePhoneFallback()} className="w-full text-sm text-gray-600 hover:text-gray-800 underline disabled:opacity-40">
                Use My Phone Instead
              </button>}
            </form>
          ) : (
            <form onSubmit={handlePhoneCall} className="space-y-4">
              <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm text-gray-700">Aria calls your phone first. Answer it to connect to the customer.</div>
              <div>
                <label htmlFor="fallback-rep-phone" className="block text-sm font-medium text-gray-700 mb-1">Your Phone Number</label>
                <input id="fallback-rep-phone" type="tel" value={repPhone} onChange={(e) => setRepPhone(e.target.value)} disabled={phoneBusy} placeholder="(616) 555-1234" className="w-full rounded-xl border border-gray-300 px-4 py-3 disabled:bg-gray-50" />
                {repPhoneError && <p className="text-xs text-red-600 mt-1">{repPhoneError}</p>}
              </div>
              <div>
                <label htmlFor="fallback-customer-phone" className="block text-sm font-medium text-gray-700 mb-1">Customer's Phone Number</label>
                <input id="fallback-customer-phone" type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} disabled={phoneBusy} placeholder="(616) 555-6789" className="w-full rounded-xl border border-gray-300 px-4 py-3 disabled:bg-gray-50" />
                {customerPhoneError && <p className="text-xs text-red-600 mt-1">{customerPhoneError}</p>}
              </div>
              {phoneState === 'ringing-rep' ? (
                <div role="status" className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-900">Aria is calling your phone. Answer to be connected.</div>
              ) : (
                <button type="submit" disabled={phoneBusy} className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-4 rounded-xl text-lg">
                  {phoneState === 'placing' ? 'Placing call…' : 'Start Phone Meeting'}
                </button>
              )}
              {!phoneBusy && <button type="button" onClick={() => { setMode('browser'); setErrorMsg(''); setPhoneState('idle'); }} className="w-full text-sm text-gray-600 underline">Back to Call from Browser</button>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
