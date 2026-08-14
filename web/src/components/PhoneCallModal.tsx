import React, { useState } from 'react';
import { startOutboundCall } from '../lib/api';

interface Props {
  onClose: () => void;
  // Called once the backend confirms a meeting was linked to the call, so
  // the parent (HomePage) can navigate the rep straight into that meeting
  // — mirrors CustomerIntakeModal's onCreated(customerId, title) contract,
  // just with a meetingId instead since a phone meeting has no title step.
  onMeetingReady: (meetingId: string) => void;
}

type CallState = 'idle' | 'placing' | 'ringing-rep' | 'failed';

// Client-side sanity check ONLY — not authoritative. The backend
// (server/telephony.js's normalizePhoneNumber, via libphonenumber-js)
// does the real E.164 parsing/validation; this is just a fast, dependency-
// free check so a rep gets an inline error before round-tripping to the
// server for something obviously wrong (empty, letters, too short). Per
// the task's hard rule: do NOT add an npm dependency for this.
function looksLikePhoneNumber(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Strip common formatting chars (spaces, dashes, parens, dots, leading +)
  // then require 10-15 remaining digits — covers a bare 10-digit US number
  // typed as "(616) 555-1234" as well as an already-E.164 "+16165551234".
  const digitsOnly = trimmed.replace(/^\+/, '').replace(/[\s().-]/g, '');
  return /^\d{10,15}$/.test(digitsOnly);
}

export default function PhoneCallModal({ onClose, onMeetingReady }: Props) {
  const [repPhone, setRepPhone] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [repPhoneError, setRepPhoneError] = useState('');
  const [customerPhoneError, setCustomerPhoneError] = useState('');
  const [callState, setCallState] = useState<CallState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const busy = callState === 'placing' || callState === 'ringing-rep';

  function validate(): boolean {
    let ok = true;
    if (!looksLikePhoneNumber(repPhone)) {
      setRepPhoneError('Enter a valid phone number, e.g. (616) 555-1234');
      ok = false;
    } else {
      setRepPhoneError('');
    }
    if (!looksLikePhoneNumber(customerPhone)) {
      setCustomerPhoneError('Enter a valid phone number, e.g. (616) 555-1234');
      ok = false;
    } else {
      setCustomerPhoneError('');
    }
    return ok;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (!validate()) return;

    setCallState('placing');
    try {
      const result = await startOutboundCall(repPhone.trim(), customerPhone.trim());
      // The server has already dialed the rep's phone by the time this
      // resolves (it's a synchronous REST call to Twilio) — reflect that
      // in the copy rather than a generic "connecting" spinner.
      setCallState('ringing-rep');
      if (result.meetingId) {
        onMeetingReady(result.meetingId);
      }
      // If meetingId is null, the call was still placed for real (server
      // logs this as a DB-write failure, not a call failure) — nothing
      // further for this modal to do; the rep's phone is genuinely
      // ringing. Leave the "ringing" state up rather than erroring, since
      // erroring here would be misleading (the call itself succeeded).
    } catch (err: unknown) {
      setCallState('failed');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to place call');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={busy ? undefined : onClose} />

      <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 pt-5 pb-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">Call a Customer</h2>
          {!busy && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
              ×
            </button>
          )}
        </div>

        <div className="px-5 py-5 space-y-4">
          {/* Recording disclosure — plain, factual, always visible, never
              buried behind a tooltip/collapse. Per task spec: no legal
              claims, just what actually happens. */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex gap-3">
            <span className="text-lg leading-none">⏺️</span>
            <p className="text-sm text-amber-900">
              This call will be recorded. Aria will call your phone first; once you answer, a recorded
              message plays before the customer is connected letting them know the call is recorded.
            </p>
          </div>

          {callState === 'idle' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {errorMsg && (
                <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">{errorMsg}</div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Your Phone Number</label>
                <input
                  type="tel"
                  value={repPhone}
                  onChange={(e) => setRepPhone(e.target.value)}
                  placeholder="(616) 555-1234"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
                {repPhoneError && <p className="text-xs text-red-600 mt-1">{repPhoneError}</p>}
                <p className="text-xs text-gray-400 mt-1">Aria calls this number first — answer to be connected.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer's Phone Number</label>
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="(616) 555-6789"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
                {customerPhoneError && <p className="text-xs text-red-600 mt-1">{customerPhoneError}</p>}
              </div>

              <div className="pt-2 pb-2">
                <button
                  type="submit"
                  className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-4 rounded-xl transition-colors text-lg"
                >
                  📞 Start Phone Meeting
                </button>
              </div>
            </form>
          )}

          {callState === 'placing' && (
            <div className="py-8 text-center space-y-3">
              <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full mx-auto" />
              <p className="text-gray-600 text-sm">Placing call…</p>
            </div>
          )}

          {callState === 'ringing-rep' && (
            <div className="py-8 text-center space-y-3">
              <div className="text-4xl">📱</div>
              <p className="text-gray-900 font-semibold">Aria is calling your phone</p>
              <p className="text-gray-500 text-sm">
                Answer to be connected. You'll hear the recording disclosure, then the customer will join.
              </p>
              <button
                onClick={onClose}
                className="mt-2 text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Close this window
              </button>
            </div>
          )}

          {callState === 'failed' && (
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <p className="text-sm font-medium text-red-800 mb-1">Couldn't place the call</p>
                <p className="text-sm text-red-700">{errorMsg}</p>
              </div>
              <button
                onClick={() => { setCallState('idle'); setErrorMsg(''); }}
                className="w-full bg-brand-700 hover:bg-brand-800 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
