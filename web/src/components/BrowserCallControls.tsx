import React from 'react';
import { browserCallStatusLabel, useBrowserCall } from '../lib/browserCall';

export default function BrowserCallControls({ meetingId }: { meetingId: string }) {
  const call = useBrowserCall();
  if (call.meetingId !== meetingId) return null;

  const active = ['initializing', 'dialing', 'ringing', 'connecting', 'connected'].includes(call.state);
  return (
    <section
      aria-label="Browser call controls"
      data-browser-call-controls
      className="sticky top-2 z-40 mx-auto w-full max-w-xl rounded-2xl border border-blue-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 flex-none rounded-full ${active ? 'bg-green-500 animate-pulse' : call.state === 'error' ? 'bg-red-500' : 'bg-gray-400'}`} />
        <p role="status" className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800">
          Browser call · {browserCallStatusLabel(call.state, call.muted)}
        </p>
        {call.state === 'connected' && (
          <button
            type="button"
            onClick={call.toggleMute}
            className="flex-none rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700"
          >
            {call.muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {active && (
          <button
            type="button"
            onClick={call.hangUp}
            className="flex-none rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white"
          >
            Hang Up
          </button>
        )}
        {!active && (
          <button type="button" onClick={call.clear} className="flex-none px-2 py-2 text-xs font-semibold text-gray-500">
            Dismiss
          </button>
        )}
      </div>
      {call.error && <p className="mt-1 truncate text-xs text-red-600">{call.error}</p>}
    </section>
  );
}
