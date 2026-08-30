// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CoachingPanel, { CoachingData } from './CoachingPanel';

const checklist = Array.from({ length: 11 }, (_, index) => ({
  id: `item-${index + 1}`,
  label: `Checklist item ${index + 1} has readable guidance`,
  done: index < 3,
}));

const coaching: CoachingData = {
  disc: { detected: 'D', confidence: 'high', emoji: '🎯', label: 'Direct', tip: 'Keep it concise.' },
  stage: { current: 'first_go_around', label: 'First Go Around' },
  checklist,
  nudges: ['Ask the next question.'],
  urgent: null,
};

afterEach(cleanup);

function expectWaitingSections(panel: HTMLElement) {
  for (const section of ['disc', 'urgent', 'stage', 'checklist', 'nudges']) {
    expect(panel.querySelector(`[data-coaching-section="${section}"] [data-coaching-waiting="${section}"]`)?.textContent)
      .toBe('Waiting on data...');
  }
}

describe('CoachingPanel empty and live states', () => {
  it.each<[string, CoachingData | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['explicitly empty fields', { disc: null, stage: null, checklist: [], nudges: [], urgent: null }],
  ])('always renders the complete panel with section placeholders for %s coaching', (_name, value) => {
    render(<CoachingPanel coaching={value} />);
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });

    // No collapse/minimize toggle exists anywhere in the panel.
    expect(screen.queryByRole('button', { name: /ARIA Coaching/ })).toBeNull();
    expect(within(panel).queryByText('▾')).toBeNull();
    expect(within(panel).queryByText('▴')).toBeNull();
    expect(within(panel).getByText('ARIA Coaching')).toBeTruthy();
    expectWaitingSections(panel);
    expect(within(panel).getAllByText('Waiting on data...')).toHaveLength(5);
    // The panel always fills the full height of its container.
    expect(panel.className).toContain('flex-1');
    expect(panel.className).toContain('flex-col');
    // aria_coaching_left_panel_space_between_layout: Troy's explicit
    // exception — the fully-empty "Waiting on data..." state must NOT get
    // the new justify-between layout; it keeps the original space-y-4 flow.
    const body = panel.querySelector('[data-coaching-body]');
    expect(body?.className).toContain('space-y-4');
    expect(body?.className).not.toContain('justify-between');
  });

  it('replaces placeholders with real content live without remounting the panel, and stays full height in both states', () => {
    const { rerender } = render(<CoachingPanel coaching={null} />);
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });
    expectWaitingSections(panel);
    const emptyStateClassName = panel.className;

    rerender(<CoachingPanel coaching={{ ...coaching, urgent: 'Pause and address the concern.' }} />);

    expect(screen.getByRole('region', { name: 'ARIA Coaching' })).toBe(panel);
    expect(within(panel).queryByText('Waiting on data...')).toBeNull();
    expect(within(panel).getByText('Direct')).toBeTruthy();
    expect(within(panel).getByText('First Go Around')).toBeTruthy();
    expect(within(panel).getByText(checklist[10].label)).toBeTruthy();
    expect(within(panel).getByText('Ask the next question.')).toBeTruthy();
    expect(within(panel).getByText('Pause and address the concern.')).toBeTruthy();
    // Root className (and therefore the full-height layout contract) is
    // identical whether the panel is showing placeholders or real data.
    expect(panel.className).toBe(emptyStateClassName);

    // aria_coaching_left_panel_space_between_layout: once real coaching
    // data has arrived, the body wrapper switches to the top/bottom-
    // anchored, evenly-spaced layout instead of the fixed space-y-4 gap.
    const body = panel.querySelector('[data-coaching-body]');
    expect(body?.className).toContain('justify-between');
    expect(body?.className).toContain('flex-col');
    expect(body?.className).not.toContain('space-y-4');
  });

  it('applies the space-between layout for a partial coaching pass (some sections still waiting), not just a fully-populated one', () => {
    render(<CoachingPanel coaching={{ checklist, nudges: ['Ask the next question.'] }} />);
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });
    const body = panel.querySelector('[data-coaching-body]');

    // disc/stage/urgent are still individually showing "Waiting on data..."
    // placeholders, but the panel as a whole has real data (checklist +
    // nudges) — Troy's exception is only for the FULLY empty state.
    expect(panel.querySelector('[data-coaching-waiting="disc"]')).toBeTruthy();
    expect(body?.className).toContain('justify-between');
    expect(body?.className).not.toContain('space-y-4');
  });

  it('keeps placeholders only for sections missing from a partial coaching pass', () => {
    render(<CoachingPanel coaching={{ checklist, nudges: ['Ask the next question.'] }} />);
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });

    expect(panel.querySelector('[data-coaching-waiting="disc"]')).toBeTruthy();
    expect(panel.querySelector('[data-coaching-waiting="stage"]')).toBeTruthy();
    expect(panel.querySelector('[data-coaching-waiting="urgent"]')).toBeTruthy();
    expect(panel.querySelector('[data-coaching-waiting="checklist"]')).toBeNull();
    expect(panel.querySelector('[data-coaching-waiting="nudges"]')).toBeNull();
  });
});

describe('CoachingPanel checklist layout', () => {
  it('renders all 11 items in a responsive multi-column grid with count and completion state intact', () => {
    const { container } = render(<CoachingPanel coaching={coaching} />);
    const list = container.querySelector('[data-coaching-checklist]');
    const items = Array.from(container.querySelectorAll('[data-coaching-checklist-item]'));

    expect(list).toBeTruthy();
    expect(list!.className).toContain('grid');
    expect(list!.className).toContain('sm:grid-cols-2');
    expect(items).toHaveLength(11);
    expect(screen.getByText('3/11')).toBeTruthy();
    expect(screen.getAllByText('✅')).toHaveLength(3);
    expect(screen.getAllByText('🔲')).toHaveLength(8);
    expect(screen.getByText(checklist[10].label)).toBeTruthy();
    expect(screen.getByText(checklist[0].label).className).toContain('line-through');
  });

  it('always renders the checklist section — there is no collapse toggle to hide it', () => {
    const { container } = render(<CoachingPanel coaching={coaching} />);
    expect(screen.queryByRole('button', { name: /ARIA Coaching/ })).toBeNull();
    expect(container.querySelectorAll('[data-coaching-checklist-item]')).toHaveLength(11);
  });

  it('renders the checklist section last, below all other coaching sections', () => {
    const { container } = render(
      <CoachingPanel coaching={{ ...coaching, urgent: 'Pause and address the concern.' }} />
    );
    const sections = Array.from(container.querySelectorAll('[data-coaching-section]')).map(
      el => el.getAttribute('data-coaching-section')
    );

    expect(sections[sections.length - 1]).toBe('checklist');
    expect(sections).toEqual(['disc', 'urgent', 'stage', 'nudges', 'progress', 'checklist']);
  });

  it('renders the progress bar as the second-to-last section, directly above the checklist', () => {
    const { container } = render(
      <CoachingPanel coaching={{ ...coaching, urgent: 'Pause and address the concern.' }} />
    );
    const sections = Array.from(container.querySelectorAll('[data-coaching-section]')).map(
      el => el.getAttribute('data-coaching-section')
    );

    expect(sections[sections.length - 2]).toBe('progress');
    expect(sections[sections.length - 1]).toBe('checklist');
  });
});
