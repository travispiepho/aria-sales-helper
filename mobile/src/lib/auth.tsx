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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
