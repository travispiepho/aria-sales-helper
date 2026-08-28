// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import AppPageLayout from './AppPageLayout';

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'rep-1', name: 'Gabe Rivera' } }),
}));

afterEach(cleanup);

describe('AppPageLayout', () => {
  it('sequences header, navigation, and content as normal-flow siblings', () => {
    const { container } = render(
      <MemoryRouter>
        <AppPageLayout title="ARIA">
          <section data-testid="first-content">First content</section>
        </AppPageLayout>
      </MemoryRouter>,
    );

    const layout = container.querySelector('[data-page-layout="flow"]') as HTMLElement;
    const header = container.querySelector('[data-app-header="compact"]') as HTMLElement;
    const navigation = screen.getByRole('navigation', { name: 'Authenticated navigation' });
    const content = container.querySelector('[data-page-content]') as HTMLElement;

    expect(layout.children[0]).toBe(header);
    expect(layout.children[1]).toBe(content);
    expect(header.contains(navigation)).toBe(true);
    expect(content.contains(screen.getByTestId('first-content'))).toBe(true);
    expect(header.className).not.toMatch(/\b(?:absolute|fixed|sticky)\b/);
    expect(navigation.className).not.toMatch(/\b(?:absolute|fixed|sticky)\b/);
    expect(content.className).not.toMatch(/(?:^|\s)-mt-/);
    expect(content.className).toContain('pt-4');
  });
});
