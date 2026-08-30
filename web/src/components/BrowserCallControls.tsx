import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { browserCallStatusLabel, useBrowserCall } from '../lib/browserCall';
import { postRecordingPath } from '../lib/meetingRoutes';

export default function BrowserCallControls({ meetingId }: { meetingId: string }) {
  const call = useBrowserCall();
  const navigate = useNavigate();
  const [finalizing, setFinalizing] = useState(false);

  useEffect(() => {
    if (call.meetingId !== meetingId || call.state !== 'ended') return;
    let cancelled = false;
    setFinalizing(true);
    call.waitForTerminal()
      .then(id => {
        if (!cancelled && id) navigate(postRecordingPath(id), { replace: true });
      })
      .catch(() => {
        // A status read failure is not proof the meeting ended. Stay active.
      })
      .finally(() => { if (!cancelled) setFinalizing(false); });
    return () => { cancelled = true; };
  }, [call.meetingId, call.state, call.waitForTerminal, meetingId, navigate]);

  if (call.meetingId !== meetingId) return null;

  // 2026-08-29 (aria_browser_call_end_meeting_button): Mute and Hang Up were
  // removed from this sticky status bar entirely — ending a browser call now
  // happens exclusively via the standard "⏹ End Meeting" control at the
  // bottom of MeetingPage's left column (shared EndMeetingButton, same as
  // in-person/uploaded-recording), which composes browserCall.hangUp() with
  // the existing meeting-finalization PATCH. Mute is not relocated anywhere
  // — removing it here is the explicit intent of that task, not an oversight.
  // This bar is now purely a status readout (plus Dismiss once ended/errored).
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
          Browser call · {finalizing ? 'Finalizing meeting…' : browserCallStatusLabel(call.state, call.muted)}
        </p>
        {!active && !finalizing && (
          <button type="button" onClick={call.clear} className="flex-none px-2 py-2 text-xs font-semibold text-gray-500">
            Dismiss
          </button>
        )}
      </div>
      {call.error && <p className="mt-1 truncate text-xs text-red-600">{call.error}</p>}
    </section>
  );
}
