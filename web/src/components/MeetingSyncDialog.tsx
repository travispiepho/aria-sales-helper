/**
 * MeetingSyncDialog.tsx — Live meeting sync (mobile → web), 2026-08-05
 *
 * Read-only "meeting in progress" dialog shown to any OTHER logged-in web
 * session belonging to the same account as a MOBILE-originated meeting.
 * See useMeetingSync.ts for the full sync/WS architecture write-up.
 *
 * HARD REQUIREMENT (Troy, verbatim): "the meeting should only be able to be
 * ended on the device that started the meeting in the first place (so you
 * will have to remove an end meeting button during a synced call)". This
 * component renders NO end/stop/finalize control anywhere, and does not
 * import or call updateMeeting()/any PATCH-issuing function at all — there
 * is no client-side code path in this file that could even attempt to end
 * the meeting, let alone a hidden one. Server-side enforcement (the actual
 * requirement, per the task's explicit "not just hidden in the UI" note)
 * lives in server.js's PATCH /api/meetings/:id owner_session_id check —
 * see this task's report for a real HTTP test proving a synced session's
 * direct PATCH attempt is rejected with 403 even bypassing this UI entirely.
 */

import React from 'react';
import { useMeetingSync } from '../lib/useMeetingSync';

export default function MeetingSyncDialog() {
  const { status, meeting, segments, interim, coaching, dismissed, dismiss } = useMeetingSync();

  if (status === 'none' || dismissed) return null;

  const ended = status === 'ended';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className={`px-4 py-4 rounded-t-2xl sm:rounded-t-2xl ${ended ? 'bg-gray-600' : 'bg-green-700'} text-white`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-white/70">
                {ended ? 'Meeting ended' : 'Live meeting in progress'}
              </p>
              <h2 className="font-bold text-lg">
                {meeting?.title || meeting?.customer_name || 'Meeting on your mobile device'}
              </h2>
            </div>
            {!ended && (
              <span className="w-3 h-3 rounded-full bg-red-400 animate-pulse" title="Recording on another device" />
            )}
          </div>
          <p className="text-white/70 text-xs mt-1">
            📱 Started on your mobile device — read-only view. End the meeting from that device.
          </p>
        </div>

        {/* Coaching snippet (minimal — see report re: full CoachingPanel parity) */}
        {coaching && (coaching.disc || coaching.stage || (coaching.nudges && coaching.nudges.length > 0)) && (
          <div className="px-4 py-3 bg-indigo-50 border-b border-indigo-100 text-sm">
            {coaching.stage && (
              <p className="text-indigo-700 font-semibold mb-1">🧭 {coaching.stage.label}</p>
            )}
            {coaching.disc && (
              <p className="text-indigo-600 mb-1">
                {coaching.disc.emoji} {coaching.disc.label} — {coaching.disc.tip}
              </p>
            )}
            {coaching.nudges && coaching.nudges.length > 0 && (
              <p className="text-indigo-500 text-xs">💡 {coaching.nudges[0]}</p>
            )}
          </div>
        )}

        {/* Live transcript */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {segments.length === 0 && !interim ? (
            <p className="text-sm text-gray-400 text-center py-6">
              {ended ? 'No transcript captured.' : 'Waiting for live transcript…'}
            </p>
          ) : (
            <>
              {segments.map((seg, i) => (
                <div key={i} className="text-sm">
                  <span className="font-semibold text-blue-700">{seg.speaker}:</span>{' '}
                  <span className="text-gray-800">{seg.text}</span>
                </div>
              ))}
              {interim && (
                <div className="text-sm">
                  <span className="font-semibold text-gray-400">{interim.speaker}:</span>{' '}
                  <span className="text-gray-400 italic">{interim.text}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — dismiss only, deliberately no end/stop control (see file header) */}
        <div className="px-4 py-3 border-t border-gray-100">
          <button
            onClick={dismiss}
            className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-xl text-sm transition-colors"
          >
            {ended ? 'Close' : 'Dismiss (keeps syncing in background)'}
          </button>
        </div>
      </div>
    </div>
  );
}
