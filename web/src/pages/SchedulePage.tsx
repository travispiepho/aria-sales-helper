import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppPageLayout from '../components/AppPageLayout';

// Entry point for the persistent schedule-ahead flow. Both destinations use
// the same normal-flow authenticated page shell as this screen so wrapped
// navigation always finishes before the scheduling controls begin.
export default function SchedulePage() {
  const navigate = useNavigate();

  return (
    <AppPageLayout title="Schedule Ahead" backTo="/" contentClassName="max-w-lg mx-auto">
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
    </AppPageLayout>
  );
}
