// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const api = vi.hoisted(() => ({ getMeeting: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null as null | { id: string; name: string }, loading: false }));
vi.mock('./lib/api', () => api);
vi.mock('./lib/auth', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => auth,
}));
vi.mock('./lib/browserCall', () => ({ BrowserCallProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./lib/useMeetingSyncWatcher', () => ({ useMeetingSyncWatcher: vi.fn() }));
vi.mock('./lib/iosCheck', () => ({ isIOSTooOld: () => false }));
vi.mock('./pages/LoginPage', () => ({ default: () => <h1>Login page</h1> }));
vi.mock('./pages/HomePage', () => ({
  default: () => (
    <>
      <h1>Home page</h1>
      <nav aria-label="Authenticated navigation">Home navigation</nav>
    </>
  ),
}));
vi.mock('./pages/MeetingsPage', () => ({
  default: () => (
    <>
      <h1>Meetings index page</h1>
      <nav aria-label="Authenticated navigation">Recorded navigation</nav>
    </>
  ),
}));
vi.mock('./pages/InRecordingPage', async () => {
  const { default: AppHeader } = await import('./components/AppHeader');
  return { default: () => <><AppHeader title="Active meeting" /><h1>Active meeting page</h1></> };
});
vi.mock('./pages/PostRecordingPage', async () => {
  const { default: AppHeader } = await import('./components/AppHeader');
  return { default: () => <><AppHeader title="Post meeting" /><h1>Post meeting page</h1></> };
});
vi.mock('./pages/ProfilePage', async () => {
  const { default: AppHeader } = await import('./components/AppHeader');
  return { default: () => <AppHeader title="Profile" /> };
});
vi.mock('./pages/AdminUsersPage', () => ({ default: () => null }));
vi.mock('./pages/SettingsPage', async () => {
  const { default: AppHeader } = await import('./components/AppHeader');
  return { default: () => <AppHeader title="Settings" /> };
});
vi.mock('./pages/SchedulePage', () => ({ default: () => null }));
vi.mock('./pages/ScheduleCallPage', () => ({ default: () => null }));
vi.mock('./pages/ScheduleVisitPage', () => ({ default: () => null }));
vi.mock('./pages/EditScheduledMeetingPage', () => ({ default: () => <h1>Edit scheduled meeting page</h1> }));
vi.mock('./pages/ObjectionsPage', async () => {
  const { default: AppHeader } = await import('./components/AppHeader');
  return { default: () => <AppHeader title="Objections" /> };
});
vi.mock('./pages/SignupClaimPage', () => ({ default: () => null }));

beforeEach(() => {
  auth.user = null;
  auth.loading = false;
  api.getMeeting.mockReset();
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

  it('protects and refreshes the scheduled-edit deep link', async () => {
    const anonymous = go('/schedule/meeting-1/edit');
    expect(await screen.findByRole('heading', { name: 'Login page' })).toBeTruthy();
    anonymous.unmount();
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    go('/schedule/meeting-1/edit');
    expect(await screen.findByRole('heading', { name: 'Edit scheduled meeting page' })).toBeTruthy();
    expect(window.location.pathname).toBe('/schedule/meeting-1/edit');
  });

  it.each([
    '/meetings/in-person-1/active',
    '/meetings/browser-phone-1/active',
    '/meetings/uploaded-recording-1/active',
  ])('hides shared navigation on the canonical active composition at %s', async path => {
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    go(path);
    expect(await screen.findByRole('heading', { name: 'Active meeting page' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Authenticated navigation' })).toBeNull();
  });

  it('hides shared navigation in the local uploaded-recording workspace', async () => {
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    go('/recordings/analyze');
    expect(await screen.findByRole('heading', { name: 'Active meeting page' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Authenticated navigation' })).toBeNull();
  });

  it.each([
    ['/', 'Home page'],
    ['/meetings', 'Meetings index page'],
    ['/meetings/meeting-1/post', 'Post meeting page'],
    ['/objections', 'Objections'],
    ['/settings', 'Settings'],
    ['/profile', 'Profile'],
  ])('shows shared navigation on %s', async (path, heading) => {
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    go(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Authenticated navigation' })).toBeTruthy();
  });

  it('resolves the authenticated index and detail routes independently', async () => {
    auth.user = { id: 'rep-1', name: 'Gabe Rivera' };
    const { unmount } = go('/meetings');
    expect(await screen.findByRole('heading', { name: 'Meetings index page' })).toBeTruthy();
    unmount();

    api.getMeeting.mockResolvedValue({ id: 'meeting-1', status: 'completed' });
    go('/meetings/meeting-1');
    await waitFor(() => expect(window.location.pathname).toBe('/meetings/meeting-1/post'));
    expect(await screen.findByRole('heading', { name: 'Post meeting page' })).toBeTruthy();
  });
});
