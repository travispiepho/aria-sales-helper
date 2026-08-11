import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { isIOSTooOld } from './lib/iosCheck';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import MeetingPage from './pages/MeetingPage';
import ProfilePage from './pages/ProfilePage';
import AdminUsersPage from './pages/AdminUsersPage';
import SettingsPage from './pages/SettingsPage';
// 2026-08-05 (live meeting sync, full-page rebuild — REPLACES the earlier
// same-day MeetingSyncDialog.tsx popup, per Gabe's explicit direction after
// live-testing it: "Instead of a popup, I would like an almost identical
// page to when you are in a meeting started on aria-web"). Mounted once at
// the authenticated-app root (via AuthedSyncGate below) for the same reason
// the popup was — it must detect a mobile-started meeting regardless of
// which page the user is currently on — but now it does so by NAVIGATING
// this tab to the meeting's normal /meetings/:id route/component (the same
// one a web-started meeting renders) instead of opening a separate,
// limited-UI dialog. See useMeetingSyncWatcher.ts and MeetingPage.tsx's
// observer-mode render branches for the full rework.
import { useMeetingSyncWatcher } from './lib/useMeetingSyncWatcher';

function IOSWarning() {
  return (
    <div className="min-h-screen bg-yellow-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm text-center">
        <div className="text-5xl mb-4">📱</div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">iOS Update Required</h1>
        <p className="text-gray-600 mb-4">
          ARIA requires iOS 16.4 or later for microphone access and offline support.
        </p>
        <p className="text-sm text-gray-400">
          Go to Settings → General → Software Update to upgrade.
        </p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-brand-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// Actually opens the /api/sync socket (via useMeetingSyncWatcher). Split
// into its own component so the hook is only ever CALLED once `user` is
// known-authenticated — React hooks can't be called conditionally inside
// a single component, so "don't open a socket before login" has to be
// enforced by conditionally MOUNTING this component instead (see
// AuthedSyncGate below), not by an early-return after the hook call.
function MeetingSyncWatcherMount() {
  useMeetingSyncWatcher();
  return null;
}

// 2026-08-05 (live meeting sync, full-page rebuild): mounted ONCE, alongside
// (not inside) the route tree below, so it survives navigation between
// HomePage/MeetingPage/ProfilePage without re-mounting its WebSocket
// connection on every route change. Only active once `user` is resolved —
// no point opening an authenticated /api/sync socket before we know a
// session exists, and it must not run (or open any socket) on /login.
// Renders nothing itself — it's a pure side-effect hook that calls
// navigate() when a mobile-started meeting is detected; the actual UI for
// that meeting is MeetingPage itself (rendered by the route below once
// navigation lands there), not a separate component tree.
function AuthedSyncGate() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <MeetingSyncWatcherMount />;
}

export default function App() {
  const [showIOSWarning, setShowIOSWarning] = useState(false);

  useEffect(() => {
    if (isIOSTooOld()) {
      setShowIOSWarning(true);
    }
  }, []);

  if (showIOSWarning) {
    return <IOSWarning />;
  }

  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthedSyncGate />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/meetings/:id"
            element={
              <RequireAuth>
                <MeetingPage />
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <ProfilePage />
              </RequireAuth>
            }
          />
          {/* Admin-only user management (2026-08-10). Server enforces
              role === 'admin'; the page itself renders a friendly 403
              card for a non-admin who somehow lands here, and quietly
              redirects unauthenticated users via RequireAuth as usual. */}
          <Route
            path="/admin/users"
            element={
              <RequireAuth>
                <AdminUsersPage />
              </RequireAuth>
            }
          />
          {/* Settings (2026-08-10). Open to all logged-in users — no
              admin-only route guard here. The page itself conditionally
              renders a link to /admin/users only when user?.role ===
              'admin' (AdminUsersPage.tsx already enforces its own
              admin check server-side + client-side). */}
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
