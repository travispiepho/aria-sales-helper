import React from 'react';

// ─── EndMeetingButton ───────────────────────────────────────────────────────
// Shared "⏹ End Meeting" control extracted from MeetingPage.tsx (the
// in-person active-meeting flow) so every active-meeting-shaped page that
// needs to end/finalize its session — in-person, and now the uploaded-
// recording analysis page — renders and behaves identically: same label,
// same icon, same full-width red button styling, and the same
// `data-meeting-end-control` hook the shared active-meeting CSS
// (`.active-meeting-end-control` / `.uploaded-type-column > div:has(>
// [data-meeting-end-control])`) already targets to pin it to the bottom of
// the left/type column. Callers decide what "ending" actually means
// (PATCH meeting completed for MeetingPage, finalize the upload transport
// for UploadedRecordingPage) — this component is presentation + the click
// hand-off only, not the finalize logic itself.
// Deliberately does NOT carry `data-meeting-end-control` itself — both call
// sites wrap this in their own element bearing that attribute (see
// MeetingPage.tsx's `<div data-meeting-end-control className="active-
// meeting-end-control">` and UploadedRecordingPage.tsx's equivalent), which
// is what the shared active-meeting CSS and this project's existing tests
// (`[data-meeting-end-control] button` descendant assertions) expect: the
// attribute on an ancestor, a plain <button> nested inside it.
export function EndMeetingButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-4 rounded-2xl text-lg transition-colors disabled:opacity-50"
    >
      ⏹ End Meeting
    </button>
  );
}

// ─── EndMeetingConfirmModal ─────────────────────────────────────────────────
// Shared confirmation dialog shown before an in-progress/active session is
// actually torn down (MeetingPage: mid-recording; UploadedRecordingPage:
// mid-analysis). Confirm calls the caller's own finalize handler; Cancel
// just dismisses with no side effects and the session continues.
export function EndMeetingConfirmModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <div className="text-center mb-4">
          <div className="text-4xl mb-2">⏹</div>
          <h2 className="text-lg font-bold text-gray-900">End this meeting?</h2>
        </div>
        <p className="text-sm text-gray-600 text-center mb-5">
          This will stop recording and finalize the meeting.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border border-gray-200 text-gray-600 font-semibold py-3 rounded-xl text-sm hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
          >
            ⏹ End Meeting
          </button>
        </div>
      </div>
    </div>
  );
}
