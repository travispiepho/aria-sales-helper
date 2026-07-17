import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-brand-700 text-white px-4 pt-4 pb-6 safe-top">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="text-brand-100 hover:text-white text-xl leading-none p-1"
            aria-label="Back"
          >
            ←
          </button>
          <h1 className="text-xl font-bold">Profile</h1>
        </div>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">

        {/* Avatar + name card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-brand-600 flex items-center justify-center text-white text-2xl font-bold flex-shrink-0">
            {user?.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div>
            <p className="text-lg font-semibold text-gray-900">{user?.name || '—'}</p>
            <p className="text-sm text-gray-500">{user?.email || '—'}</p>
            <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 capitalize">
              {user?.role || 'rep'}
            </span>
          </div>
        </div>

        {/* App info */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-100">
          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">App</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Product</span>
                <span className="text-sm font-medium text-gray-900">ARIA Sales Helper</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Company</span>
                <span className="text-sm font-medium text-gray-900">CertaPro Grand Haven</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Version</span>
                <span className="text-sm font-medium text-gray-500">Phase 3</span>
              </div>
            </div>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={logout}
          className="w-full bg-white border border-red-200 hover:bg-red-50 text-red-600 font-semibold py-4 rounded-2xl transition-colors text-sm"
        >
          Sign Out
        </button>

      </div>
    </div>
  );
}
