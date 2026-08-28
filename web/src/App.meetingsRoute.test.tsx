// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const auth = vi.hoisted(() => ({ user: null as null | { id: string; name: string }, loading: false }));
vi.mock('./lib/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => auth,
}));
vi.mock('./lib/browserCall', () => ({ BrowserCallProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./lib/useMeetingSyncWatcher', () => ({ useMeetingSyncWatcher: vi.fn() }));
vi.mock('./lib/iosCheck', () => ({ isIOSTooOld: () => false }));
vi.mock('./pages/LoginPage', () => ({ default: () => <h1>Login page</h1> }));
vi.mock('./pages/HomePage', () => ({ default: () => <h1>Home page</h1> }));
vi.mock('./pages/MeetingsPage', () => ({ default: () => <h1>Meetings index page</h1> }));
vi.mock('./pages/MeetingPage', () => ({ default: () => <h1>Meeting detail page</h1> }));
vi.mock('./pages/ProfilePage', () => ({ default: () => null }));
vi.mock('./pages/AdminUsersPage', () => ({ default: () => null }));
vi.mock('./pages/SettingsPage', () => ({ default: () => null }));
vi.mock('./pages/SchedulePage', () => ({ default: () => null }));
vi.mock('./pages/ScheduleCallPage', () => ({ default: () => null }));
vi.mock('./pages/ScheduleVisitPage', () => ({ default: () => null }));
vi.mock('./pages/ObjectionsPage', () => ({ default: () => null }));
vi.mock('./pages/SignupClaimPage', () => ({ default: () => null }));
vi.mock('./pages/UploadedRecordingPage', () => ({ default: () => null }));

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
});
afterEach(cleanup);

function go(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

describe('meeting routes', () => {
  it('protects the meetings index with the shared authentication gate', async () => {
    go('/meetings');
    expect(await screen.findByRole('heading', { name: 'Login page' })).toBeTruthy();
    expect(window.location.pathname).toBe('/login');
  });

  it('resolves the authenticated index and detail routes independently', async () => {
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    const { unmount } = go('/meetings');
    expect(await screen.findByRole('heading', { name: 'Meetings index page' })).toBeTruthy();
    unmount();

    go('/meetings/meeting-1');
    expect(await screen.findByRole('heading', { name: 'Meeting detail page' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/meetings/meeting-1'));
  });
});
