// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CoachingSettingsPage from './CoachingSettingsPage';

// CoachingSettingsPage.test.tsx (2026-08-30,
// aria_coaching_settings_merge_objections_frontend) — replaces
// CoachingStagesPage.test.tsx + ObjectionsPage.layout.test.tsx, covering
// the merged page: (a) Sales Stages section still works exactly as
// before (add/remove, admin-gated), (b) Objections browsing/rebuttal-
// adding still works exactly as before, (c) the new Coaching Prompts
// section (read-only for reps, edit affordance + validation surfacing for
// admins), and (d) that only one segmented "Coaching" surface exists now
// (no separate Objections page/tab).

const mocks = vi.hoisted(() => ({
  listCoachingStages: vi.fn(),
  createCoachingStage: vi.fn(),
  deleteCoachingStage: vi.fn(),
  listObjections: vi.fn(),
  getObjection: vi.fn(),
  createObjection: vi.fn(),
  createRebuttal: vi.fn(),
  listCoachingPrompts: vi.fn(),
  updateCoachingPrompt: vi.fn(),
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
  listObjections: mocks.listObjections,
  getObjection: mocks.getObjection,
  createObjection: mocks.createObjection,
  createRebuttal: mocks.createRebuttal,
  listCoachingPrompts: mocks.listCoachingPrompts,
  updateCoachingPrompt: mocks.updateCoachingPrompt,
}));

const SEED_STAGES = [
  { id: 's-1', key: 'setup_call', label: 'Setup Call', sort_order: 10, created_at: '', updated_at: '' },
  { id: 's-2', key: 'arrival', label: 'Arrival', sort_order: 20, created_at: '', updated_at: '' },
];

const SEED_OBJECTIONS = [
  { id: 'o-1', text: 'Your price is too high', category: 'Price', rebuttal_count: 1, created_at: '', updated_at: '' },
];

const SEED_OBJECTION_DETAIL = {
  id: 'o-1',
  text: 'Your price is too high',
  category: 'Price',
  created_at: '',
  updated_at: '',
  rebuttals: [{ id: 'r-1', objection_id: 'o-1', text: 'We include a lifetime warranty.', created_at: '', updated_at: '' }],
};

const SEED_PROMPTS = [
  { key: 'bant', label: 'BANT', prompt_text: 'Assess Budget, Authority, Need, Timeline from this transcript.', updated_at: '', updated_by: null },
  { key: 'coaching_realtime', label: 'Real-Time Coaching (In-Person)', prompt_text: 'Coach the rep in real time based on the live transcript.', updated_at: '', updated_by: null },
];

beforeEach(() => {
  mocks.listCoachingStages.mockResolvedValue({ stages: SEED_STAGES });
  mocks.listObjections.mockResolvedValue(SEED_OBJECTIONS);
  mocks.getObjection.mockResolvedValue(SEED_OBJECTION_DETAIL);
  mocks.listCoachingPrompts.mockResolvedValue({ prompts: SEED_PROMPTS });
  window.confirm = vi.fn(() => true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/coaching']}>
      <CoachingSettingsPage />
    </MemoryRouter>
  );
}

describe('CoachingSettingsPage — layout / single merged surface', () => {
  beforeEach(() => {
    mocks.useAuthUser = { id: 'rep-1', role: 'rep' };
  });

  it('renders one Coaching page with a segmented sub-nav for Sales Stages / Objections / Coaching Prompts', async () => {
    const { container } = renderPage();
    const header = container.querySelector('[data-app-header="compact"]') as HTMLElement;
    expect(header.querySelector('h1')?.textContent).toBe('Coaching');

    const tabs = screen.getByRole('tablist', { name: 'Coaching settings sections' });
    expect(within(tabs).getByRole('tab', { name: 'Sales Stages' })).toBeTruthy();
    expect(within(tabs).getByRole('tab', { name: 'Objections' })).toBeTruthy();
    expect(within(tabs).getByRole('tab', { name: 'Coaching Prompts' })).toBeTruthy();

    // Sales Stages is the default section.
    expect(await screen.findByText('Setup Call')).toBeTruthy();
  });
});

describe('CoachingSettingsPage — Sales Stages section (relocated, unchanged behavior)', () => {
  it('rep: lists stages with no add/remove controls', async () => {
    mocks.useAuthUser = { id: 'rep-1', role: 'rep' };
    renderPage();
    expect(await screen.findByText('Setup Call')).toBeTruthy();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Add Stage' })).toBeNull();
  });

  it('admin: can add a stage', async () => {
    mocks.useAuthUser = { id: 'admin-1', role: 'admin' };
    mocks.createCoachingStage.mockResolvedValue({
      id: 's-3', key: 'site_walkthrough', label: 'Site Walkthrough', sort_order: 30, created_at: '', updated_at: '',
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Setup Call')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '+ Add Stage' }));
    await user.type(screen.getByPlaceholderText('e.g. site_walkthrough'), 'site_walkthrough');
    await user.type(screen.getByPlaceholderText('e.g. Site Walkthrough'), 'Site Walkthrough');
    await user.click(screen.getByRole('button', { name: 'Save Stage' }));

    await waitFor(() => {
      expect(mocks.createCoachingStage).toHaveBeenCalledWith('site_walkthrough', 'Site Walkthrough');
    });
    expect(await screen.findByText('Site Walkthrough')).toBeTruthy();
  });

  it('admin: can remove a stage after confirming', async () => {
    mocks.useAuthUser = { id: 'admin-1', role: 'admin' };
    mocks.deleteCoachingStage.mockResolvedValue({ ok: true, historical_usage_count: 0 });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Arrival')).toBeTruthy();

    const arrivalRow = screen.getByText('Arrival').closest('li') as HTMLElement;
    await user.click(within(arrivalRow).getByRole('button', { name: /Remove/ }));

    await waitFor(() => expect(mocks.deleteCoachingStage).toHaveBeenCalledWith('arrival'));
    expect(screen.queryByText('Arrival')).toBeNull();
  });
});

describe('CoachingSettingsPage — Objections section (relocated, unchanged behavior)', () => {
  beforeEach(() => {
    mocks.useAuthUser = { id: 'rep-1', role: 'rep' };
  });

  it('switches to the Objections sub-tab, browses list, opens detail, and adds a rebuttal', async () => {
    const user = userEvent.setup();
    mocks.createRebuttal.mockResolvedValue({ id: 'r-2', objection_id: 'o-1', text: 'Cheaper materials cost more in repairs.', created_at: '', updated_at: '' });

    renderPage();
    expect(await screen.findByText('Setup Call')).toBeTruthy(); // default section loaded

    await user.click(screen.getByRole('tab', { name: 'Objections' }));
    expect(await screen.findByText('Your price is too high')).toBeTruthy();

    await user.click(screen.getByText('Your price is too high'));
    expect(await screen.findByText('We include a lifetime warranty.')).toBeTruthy();

    await user.type(screen.getByPlaceholderText("What's worked for you here?"), 'Cheaper materials cost more in repairs.');
    await user.click(screen.getByRole('button', { name: '+ Add Rebuttal' }));

    await waitFor(() => {
      expect(mocks.createRebuttal).toHaveBeenCalledWith('o-1', 'Cheaper materials cost more in repairs.');
    });
    expect(await screen.findByText('Cheaper materials cost more in repairs.')).toBeTruthy();
  });

  it('has no standalone Objections page chrome — search box lives inside the merged page content', async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Objections' }));
    const content = container.querySelector('[data-page-content]') as HTMLElement;
    expect(await screen.findByRole('textbox', { name: 'Search objections' })).toBeTruthy();
    expect(content.querySelector('[data-coaching-settings-section="objections"]')).toBeTruthy();
  });
});

describe('CoachingSettingsPage — Coaching Prompts section (new)', () => {
  it('rep sees prompts read-only, no edit affordance', async () => {
    mocks.useAuthUser = { id: 'rep-1', role: 'rep' };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Coaching Prompts' }));

    expect(await screen.findByText('BANT')).toBeTruthy();
    expect(screen.getByText('Real-Time Coaching (In-Person)')).toBeTruthy();
    expect(screen.getByText(/Assess Budget, Authority, Need, Timeline/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✏️ Edit' })).toBeNull();
    expect(screen.getByText(/Ask an admin to make changes/)).toBeTruthy();
  });

  it('admin can edit a prompt and a successful save round-trips', async () => {
    mocks.useAuthUser = { id: 'admin-1', role: 'admin' };
    mocks.updateCoachingPrompt.mockResolvedValue({
      key: 'bant', label: 'BANT', prompt_text: 'Updated BANT prompt text goes here.', updated_at: '', updated_by: 'admin-1',
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Coaching Prompts' }));
    expect(await screen.findByText('BANT')).toBeTruthy();

    const bantCard = screen.getByText('BANT').closest('[data-coaching-prompt-key="bant"]') as HTMLElement;
    await user.click(within(bantCard).getByRole('button', { name: '✏️ Edit' }));

    const textarea = within(bantCard).getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Updated BANT prompt text goes here.');
    await user.click(within(bantCard).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mocks.updateCoachingPrompt).toHaveBeenCalledWith('bant', 'Updated BANT prompt text goes here.');
    });
    expect(await within(bantCard).findByText(/Saved/)).toBeTruthy();
  });

  it('surfaces a validation error from the server without closing edit mode', async () => {
    mocks.useAuthUser = { id: 'admin-1', role: 'admin' };
    mocks.updateCoachingPrompt.mockRejectedValue(
      Object.assign(new Error('prompt_text must be at least 20 characters (this would break the coaching engine)'), { status: 400 })
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Coaching Prompts' }));
    expect(await screen.findByText('BANT')).toBeTruthy();

    const bantCard = screen.getByText('BANT').closest('[data-coaching-prompt-key="bant"]') as HTMLElement;
    await user.click(within(bantCard).getByRole('button', { name: '✏️ Edit' }));
    const textarea = within(bantCard).getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'too short');
    await user.click(within(bantCard).getByRole('button', { name: 'Save' }));

    expect(await within(bantCard).findByText(/at least 20 characters/)).toBeTruthy();
    // Still in edit mode — textarea remains visible.
    expect(within(bantCard).getByRole('textbox')).toBeTruthy();
  });
});
