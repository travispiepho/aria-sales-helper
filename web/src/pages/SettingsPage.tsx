import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { hasAdminAccess } from '../lib/roles';
import AppHeader from '../components/AppHeader';

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
// "Admin" link below when the user has admin-level access, via the shared
// hasAdminAccess() helper in lib/roles.ts (which accepts both 'admin' and
// the higher 'owner' role — added 2026-08-10). The same helper backs
// AdminUsersPage.tsx's gates and ProfilePage.tsx's role badge, so all
// three stay consistent. AdminUsersPage.tsx already has its own internal
// admin check (and the server enforces it too), so this is just a
// convenience nav entry, not a security boundary.
//
// UI pattern intentionally mirrors ProfilePage.tsx: brand-700 header with
// back arrow, rounded-2xl white cards on a gray-100 page background.

export default function SettingsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Uses the shared helper so 'owner' (which outranks admin) also sees the
  // Admin link — see lib/roles.ts for the full role model.
  const isAdmin = hasAdminAccess(user?.role);

  return (
    <div className="min-h-screen bg-gray-100">
      <AppHeader title="Settings" backTo="/" />

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

        {/* Schedule Ahead (2026-08-17 Phase 1) lived here temporarily while
            HomePage.tsx was locked by concurrent subagent work. That lock
            is released (2026-08-17 rework) and the entry now lives on the
            Home screen next to "Call a Customer" — the place a rep will
            actually look for it — so this Settings entry was removed to
            avoid two doors to the same room. See HomePage.tsx's "Ready to
            meet?" card for the new entry point. */}

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
