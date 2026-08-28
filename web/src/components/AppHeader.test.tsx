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
    expect(header?.className).not.toMatch(/\b(?:absolute|fixed|sticky)\b/);
    expect(screen.getByRole('heading', { name: 'ARIA' })).toBeTruthy();
    expect(screen.getByText('Hey Gabe 👋')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Home' }).textContent).toBe('ARIA');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    const navigation = screen.getByRole('navigation', { name: 'Authenticated navigation' });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Record' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'Meetings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(Array.from(navigation.querySelectorAll('a')).map(link => link.getAttribute('aria-label'))).toEqual([
      'Record', 'Meetings', 'Objections', 'Settings', 'Profile',
    ]);
    expect(screen.getByRole('link', { name: 'Objections' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Profile' }).textContent).toBe('G');
  });

  it('routes all shared controls and marks the current route accessibly', async () => {
    const { unmount } = renderHeader('/meetings/detail-1');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Record' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Meetings' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(screen.getByLabelText('current path').textContent).toBe('/settings');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('link', { name: 'Objections' }));
    expect(screen.getByLabelText('current path').textContent).toBe('/objections');
    unmount();

    renderHeader('/profile');
    expect(screen.getByRole('link', { name: 'Profile' }).getAttribute('aria-current')).toBe('page');
  });

  it('treats Home and Record as interchangeable current-page links on the homepage', async () => {
    renderHeader('/meetings');
    await userEvent.click(screen.getByRole('link', { name: 'Home' }));
    expect(screen.getByLabelText('current path').textContent).toBe('/');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Record' }).getAttribute('aria-current')).toBe('page');

    await userEvent.click(screen.getByRole('link', { name: 'Meetings' }));
    await userEvent.click(screen.getByRole('link', { name: 'Record' }));
    expect(screen.getByLabelText('current path').textContent).toBe('/');
  });

  it('keeps every 44px control visible and supplies a compact wrapping row at narrow widths', () => {
    const { container } = renderHeader('/schedule/call', {
      title: 'Schedule a Call',
      backTo: '/schedule',
      backLabel: 'Back to Schedule',
    });
    const nav = screen.getByRole('navigation', { name: 'Authenticated navigation' });
    const controls = [
      screen.getByRole('link', { name: 'Home' }),
      screen.getByRole('link', { name: 'Record' }),
      screen.getByRole('link', { name: 'Meetings' }),
      screen.getByRole('link', { name: 'Settings' }),
      screen.getByRole('link', { name: 'Objections' }),
      screen.getByRole('link', { name: 'Profile' }),
    ];

    expect(nav.className).toContain('max-[480px]:w-full');
    expect(nav.className).not.toMatch(/\b(?:absolute|fixed|sticky)\b/);
    expect(Array.from(nav.querySelectorAll('a')).map(link => link.getAttribute('aria-label'))).toEqual([
      'Record', 'Meetings', 'Objections', 'Settings', 'Profile',
    ]);
    expect(screen.queryByRole('link', { name: 'Back to Schedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to Schedule' })).toBeNull();
    expect(container.querySelector('.max-\\[480px\\]\\:flex-none')).toBeTruthy();
    for (const control of controls) {
      expect(control.className).toMatch(/(?:w-11|min-w-11)/);
      expect(control.className).toContain('h-11');
    }
  });
});
