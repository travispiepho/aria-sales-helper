import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader';

// SchedulePage — Phase 1 (2026-08-17).
//
// Entry point for Gabe's "schedule ahead of time" initiative. Gabe's exact
// words: "I want all calls to be scheduled ahead of time if possible. That
// includes in-person calls and in-the-field recordings. Create a new flow
// that starts with two buttons: schedule a call and schedule a visit.
// Build these first and then continue."
//
// This is intentionally THIN — two entry buttons routing to distinct
// placeholder destinations (ScheduleCallPage / ScheduleVisitPage). No
// date/time picker, no persistence, no calendar integration yet. That's
// Phase 2, scoped separately once Gabe has seen this entry flow.
//
// UI pattern mirrors SettingsPage.tsx / ProfilePage.tsx: brand-700 header
// with back arrow, rounded-2xl white cards on a gray-100 page background.
export default function SchedulePage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-200">
      <AppHeader title="Schedule Ahead" backTo="/" />

      <div className="px-4 -mt-2 pb-24 max-w-lg mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
          <h2 className="font-semibold text-gray-900 mb-1">What are you scheduling?</h2>
          <p className="text-sm text-gray-500">
            Set up a meeting in advance instead of starting it right now.
          </p>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => navigate('/schedule/call')}
            className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-left hover:border-brand-300 transition-colors flex items-center gap-4"
          >
            <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-2xl flex-shrink-0">
              📞
            </div>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">Schedule a Call</p>
              <p className="text-sm text-gray-500 mt-0.5">
                Set up an Aria-bridged phone call for later
              </p>
            </div>
            <span className="text-gray-300 text-xl">›</span>
          </button>

          <button
            onClick={() => navigate('/schedule/visit')}
            className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-left hover:border-brand-300 transition-colors flex items-center gap-4"
          >
            <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center text-2xl flex-shrink-0">
              🚗
            </div>
            <div className="flex-1">
              <p className="font-semibold text-gray-900">Schedule a Visit</p>
              <p className="text-sm text-gray-500 mt-0.5">
                Plan an in-person / in-the-field meeting for later
              </p>
            </div>
            <span className="text-gray-300 text-xl">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}
