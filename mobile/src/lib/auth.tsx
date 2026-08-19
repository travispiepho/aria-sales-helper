/**
 * auth.tsx — Auth context / hook (mirrors app/web/src/lib/auth.tsx)
 */

import React, { createContext, useContext, useEffect, useState } from 'react';

import { getCachedUser, getMe, login as apiLogin, logout as apiLogout, User } from './api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  // Patch the in-memory user object without a full getMe() round-trip.
  // Mirrors app/web/src/lib/auth.tsx's updateUser() (added 2026-08-13) so
  // self-service updates (e.g. profile.tsx's phone-number save, PATCH
  // /api/profile) can push the server's fresh row straight into the shared
  // context — otherwise a rep who saves a phone number would see the stale
  // value elsewhere in the same session until a reload/re-login.
  updateUser: (patch: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Paint instantly from the cached profile (if any) while we confirm
      // the session cookie is still valid against the server.
      const cached = await getCachedUser();
      if (cached) setUser(cached);

      try {
        const { user } = await getMe();
        setUser(user);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const { user } = await apiLogin(email, password);
    setUser(user);
  };

  const logout = async () => {
    await apiLogout();
    setUser(null);
  };

  const updateUser = (patch: Partial<User>) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
