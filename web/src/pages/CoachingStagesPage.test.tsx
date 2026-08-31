// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CoachingStagesPage from './CoachingStagesPage';

const mocks = vi.hoisted(() => ({
  listCoachingStages: vi.fn(),
  createCoachingStage: vi.fn(),
  deleteCoachingStage: vi.fn(),
  useAuthUser: null as { id: string; role: string } | null,
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: mocks.useAuthUser }),
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  listCoachingStages: mocks.listCoachingStages,
  createCoachingStage: mocks.createCoachingStage,
  deleteCoachingStage: mocks.deleteCoachingStage,
}));

const SEED_STAGES = [
  { id: 's-1', key: 'setup_call', label: 'Setup Call', sort_order: 10, created_at: '', updated_at: '' },
  { id: 's-2', key: 'arrival', label: 'Arrival', sort_order: 20, created_at: '', updated_at: '' },
  { id: 's-3', key: 'follow_up', label: 'Follow Up', sort_order: 110, created_at: '', updated_at: '' },
];

beforeEach(() => {
  mocks.listCoachingStages.mockResolvedValue({ stages: SEED_STAGES });
  window.confirm = vi.fn(() => true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/coaching']}>
      <CoachingStagesPage />
    </MemoryRouter>
  );
}

describe('CoachingStagesPage — read-only for non-admins', () => {
  beforeEach(() => {
    mocks.useAuthUser = { id: 'rep-1', role: 'rep' };
  });

  it('lists all stages in order but shows no add/remove controls for a rep', async () => {
    renderPage();

    expect(await screen.findByText('Setup Call')).toBeTruthy();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.getByText('Follow Up')).toBeTruthy();

    // Machine keys are visible too (reps can see what the engine tracks).
    expect(screen.getByText('setup_call')).toBeTruthy();

    // No admin-only affordances.
    expect(screen.queryByRole('button', { name: '+ Add Stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByText('Ask an admin to add or remove a stage.')).toBeTruthy();
  });
});

describe('CoachingStagesPage — admin add/remove', () => {
  beforeEach(() => {
    mocks.useAuthUser = { id: 'admin-1', role: 'admin' };
  });

  it('shows add/remove controls for an admin and lets them add a stage', async () => {
    const user = userEvent.setup();
    mocks.createCoachingStage.mockResolvedValue({
      id: 's-4',
      key: 'site_walkthrough',
      label: 'Site Walkthrough',
      sort_order: 120,
      created_at: '',
      updated_at: '',
    });

    renderPage();
    expect(await screen.findByText('Setup Call')).toBeTruthy();

    // Admin-only affordances present.
    expect(screen.getAllByRole('button', { name: /Remove/ }).length).toBe(SEED_STAGES.length);

    await user.click(screen.getByRole('button', { name: '+ Add Stage' }));
    await user.type(screen.getByPlaceholderText('e.g. site_walkthrough'), 'site_walkthrough');
    await user.type(screen.getByPlaceholderText('e.g. Site Walkthrough'), 'Site Walkthrough');
    await user.click(screen.getByRole('button', { name: 'Save Stage' }));

    await waitFor(() => {
      expect(mocks.createCoachingStage).toHaveBeenCalledWith('site_walkthrough', 'Site Walkthrough');
    });
    expect(await screen.findByText('Site Walkthrough')).toBeTruthy();
  });

  it('rejects an invalid key client-side before calling the API', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Setup Call')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '+ Add Stage' }));
    await user.type(screen.getByPlaceholderText('e.g. site_walkthrough'), 'Not A Valid Key');
    await user.type(screen.getByPlaceholderText('e.g. Site Walkthrough'), 'Whatever');
    await user.click(screen.getByRole('button', { name: 'Save Stage' }));

    expect(await screen.findByText(/Lowercase letters, numbers, and underscores only/)).toBeTruthy();
    expect(mocks.createCoachingStage).not.toHaveBeenCalled();
  });

  it('lets an admin remove a stage after confirming, and surfaces historical-usage warning', async () => {
    const user = userEvent.setup();
    mocks.deleteCoachingStage.mockResolvedValue({ ok: true, historical_usage_count: 3 });

    renderPage();
    expect(await screen.findByText('Arrival')).toBeTruthy();

    const arrivalRow = screen.getByText('Arrival').closest('li') as HTMLElement;
    await user.click(within(arrivalRow).getByRole('button', { name: /Remove/ }));

    await waitFor(() => {
      expect(mocks.deleteCoachingStage).toHaveBeenCalledWith('arrival');
    });
    expect(screen.queryByText('Arrival')).toBeNull();
    expect(await screen.findByText(/3 past meetings already recorded reaching this stage/)).toBeTruthy();
  });
});
