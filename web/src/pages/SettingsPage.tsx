import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// SettingsPage — 2026-08-10.
//
// Added per Gabe's explicit request: "create a link to the admin page
// that you made earlier. Make a settings page on aria-web with a settings
// icon directly next to the profile link in the navbar. This settings
// page should link to a settings page that contains a link to the admin
// settings for admin accounts."
//
// Reached via the gear icon in HomePage.tsx's header (next to the Profile
// avatar button). This page itself is open to ANY logged-in user (no
// admin gate on the page/route) — it just conditionally renders the
// "Admin" link below when `user?.role === 'admin'`, matching the exact
// role-check pattern used elsewhere (see AdminUsersPage.tsx line ~65/158
// and ProfilePage.tsx's role badge: `user?.role === 'admin'` /
// `user?.role || 'rep'`). AdminUsersPage.tsx already has its own internal
// admin check (and the server enforces it too), so this is just a
// convenience nav entry, not a security boundary.
//
// UI pattern intentionally mirrors ProfilePage.tsx: brand-700 header with
// back arrow, rounded-2xl white cards on a gray-100 page background.

export default function SettingsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const isAdmin = user?.role === 'admin';

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-brand-100 hover:text-white text-2xl leading-none p-1"
          >
            ←
          </button>
          <h1 className="text-2xl font-bold leading-tight">Settings</h1>
        </div>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">

        {/* Account */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-5 pt-4 pb-2">
            Account
          </p>
          <button
            onClick={() => navigate('/profile')}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors border-t border-gray-100 text-left"
          >
            <span className="text-sm font-medium text-gray-900">Profile</span>
            <span className="text-gray-400">›</span>
          </button>
        </div>

        {/* Admin — only rendered for admin accounts */}
        {isAdmin && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-5 pt-4 pb-2">
              Admin
            </p>
            <button
              onClick={() => navigate('/admin/users')}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors border-t border-gray-100 text-left"
            >
              <div>
                <span className="text-sm font-medium text-gray-900">Manage Users</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  View, invite, and remove team accounts
                </p>
              </div>
              <span className="text-gray-400">›</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
