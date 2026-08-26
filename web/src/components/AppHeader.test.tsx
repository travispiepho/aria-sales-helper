// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AppHeader from './AppHeader';

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }),
}));

function LocationProbe() {
  return <output aria-label="current path">{useLocation().pathname}</output>;
}

function renderHeader(path = '/', props: Partial<React.ComponentProps<typeof AppHeader>> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader title="ARIA" subtitle="Hey Gabe 👋" {...props} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('AppHeader', () => {
  it('renders the compact shared marker, greeting, and complete authenticated navigation', () => {
    const { container } = renderHeader();
    const header = container.querySelector('[data-app-header="compact"]');

    expect(header?.getAttribute('data-compact-min-height')).toBe('104px');
    expect(header?.className).toContain('min-h-[6.5rem]');
    expect(screen.getByRole('heading', { name: 'ARIA' })).toBeTruthy();
    expect(screen.getByText('Hey Gabe 👋')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Authenticated navigation' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Objections' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Profile' }).textContent).toBe('G');
  });

  it('routes all shared controls and marks the current route accessibly', async () => {
    const { unmount } = renderHeader('/settings');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('link', { name: 'Objections' }));
    expect(screen.getByLabelText('current path').textContent).toBe('/objections');
    unmount();

    renderHeader('/profile');
    expect(screen.getByRole('link', { name: 'Profile' }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps every 44px control visible and supplies a compact wrapping row at narrow widths', () => {
    const { container } = renderHeader('/schedule/call', {
      title: 'Schedule a Call',
      backTo: '/schedule',
      backLabel: 'Back to Schedule',
    });
    const nav = screen.getByRole('navigation', { name: 'Authenticated navigation' });
    const controls = [
      screen.getByRole('link', { name: 'Back to Schedule' }),
      screen.getByRole('link', { name: 'Settings' }),
      screen.getByRole('link', { name: 'Objections' }),
      screen.getByRole('link', { name: 'Profile' }),
    ];

    expect(nav.className).toContain('max-[480px]:w-full');
    expect(container.querySelector('.max-\\[480px\\]\\:flex-none')).toBeTruthy();
    for (const control of controls) {
      expect(control.className).toContain('w-11');
      expect(control.className).toContain('h-11');
    }
  });
});
