// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ObjectionsPage from './ObjectionsPage';

const mocks = vi.hoisted(() => ({ listObjections: vi.fn() }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }),
}));
vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  listObjections: mocks.listObjections,
}));

beforeEach(() => mocks.listObjections.mockResolvedValue([]));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ObjectionsPage layout', () => {
  it('renders search as the first content after shared navigation in normal flow', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/objections']}>
        <ObjectionsPage />
      </MemoryRouter>,
    );
    const header = container.querySelector('[data-app-header="compact"]') as HTMLElement;
    const content = container.querySelector('[data-page-content]') as HTMLElement;
    const search = screen.getByRole('textbox', { name: 'Search objections' });
    const firstCard = search.parentElement as HTMLElement;

    expect(header.nextElementSibling).toBe(content);
    expect(content.firstElementChild).toBe(firstCard);
    expect(header.contains(screen.getByRole('navigation', { name: 'Authenticated navigation' }))).toBe(true);
    expect(content.className).not.toMatch(/(?:^|\s)-mt-/);
    expect(firstCard.className).not.toMatch(/\babsolute\b/);
    expect(await screen.findByText('No objections yet — add the first one.')).toBeTruthy();
  });
});
