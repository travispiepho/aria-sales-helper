import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { isIOSTooOld } from './lib/iosCheck';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import MeetingPage from './pages/MeetingPage';
import ProfilePage from './pages/ProfilePage';
// 2026-08-05 (live meeting sync, mobile → web): mounted once at the
// authenticated-app root (inside RequireAuth-gated routes only, via
// AuthedSyncGate below) so the "meeting in progress" dialog can appear
// regardless of which page the user is currently on — not just while a
// MeetingPage happens to be open — satisfying requirement 1's "pull up a
// meeting dialog on all instances" (i.e. it must surface proactively, not
// only if the user happens to already be looking at that specific meeting).
import MeetingSyncDialog from './components/MeetingSyncDialog';

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

// 2026-08-05 (live meeting sync, mobile → web): mounted ONCE, alongside
// (not inside) the route tree below, so it survives navigation between
// HomePage/MeetingPage/ProfilePage without re-mounting its WebSocket
// connections (see useMeetingSync.ts) on every route change. Only rendered
// once `user` is resolved — no point opening an authenticated /api/sync
// socket before we know a session exists, and it must not render (or open
// any socket) on /login.
function AuthedSyncGate() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <MeetingSyncDialog />;
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
