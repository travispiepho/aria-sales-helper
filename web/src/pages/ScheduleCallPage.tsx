import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader';

// ScheduleCallPage — Phase 1 placeholder (2026-08-17).
//
// Destination for the "Schedule a Call" button on SchedulePage.tsx. This
// is deliberately a placeholder — no date/time picker, no persistence.
// Phase 2 will build the actual scheduling form (date/time selection,
// which customer, save to backend) and decide how a scheduled call later
// becomes a live PhoneCallModal-driven meeting (see
// components/PhoneCallModal.tsx and HomePage.tsx's "📞 Call a Customer"
// entry point for the existing ad-hoc equivalent — intentionally NOT
// wired to or edited here, per this task's file boundaries).
export default function ScheduleCallPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-100">
      <AppHeader title="Schedule a Call" backTo="/schedule" backLabel="Back to Schedule" />

      <div className="px-4 -mt-2 pb-24 max-w-lg mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
          <div className="text-4xl mb-3">🚧</div>
          <h2 className="font-semibold text-gray-900 mb-1">Coming soon</h2>
          <p className="text-sm text-gray-500">
            Scheduling a call ahead of time is on the way. For now, use
            "Call a Customer" from the home screen to start one right now.
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
