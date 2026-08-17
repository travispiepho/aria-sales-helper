import React from 'react';
import { useNavigate } from 'react-router-dom';

// ScheduleVisitPage — Phase 1 placeholder (2026-08-17).
//
// Destination for the "Schedule a Visit" button on SchedulePage.tsx.
// Covers Gabe's "in-person calls and in-the-field recordings" — this
// placeholder does not yet distinguish those two (see this task's report
// for the Phase 2 recommendation on whether they're one type or two).
// No date/time picker, no persistence in Phase 1.
export default function ScheduleVisitPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/schedule')}
            className="text-brand-100 hover:text-white text-2xl leading-none p-1"
          >
            ←
          </button>
          <h1 className="text-2xl font-bold leading-tight">Schedule a Visit</h1>
        </div>
      </div>

      <div className="px-4 -mt-2 pb-24 max-w-lg mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
          <div className="text-4xl mb-3">🚧</div>
          <h2 className="font-semibold text-gray-900 mb-1">Coming soon</h2>
          <p className="text-sm text-gray-500">
            Scheduling an in-person visit or in-the-field recording ahead
            of time is on the way. For now, use "▶ Start Meeting" from the
            home screen to begin one right now.
          </p>
          <button
            onClick={() => navigate('/')}
            className="mt-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
