// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    expect(screen.getByRole('button', { name: /ARIA Coaching/ })).toBeTruthy();
    expectWaitingSections(panel);
    expect(within(panel).getAllByText('Waiting on data...')).toHaveLength(5);
  });

  it('replaces placeholders with real content live without remounting the panel', () => {
    const { rerender } = render(<CoachingPanel coaching={null} />);
    const panel = screen.getByRole('region', { name: 'ARIA Coaching' });
    expectWaitingSections(panel);

    rerender(<CoachingPanel coaching={{ ...coaching, urgent: 'Pause and address the concern.' }} />);

    expect(screen.getByRole('region', { name: 'ARIA Coaching' })).toBe(panel);
    expect(within(panel).queryByText('Waiting on data...')).toBeNull();
    expect(within(panel).getByText('Direct')).toBeTruthy();
    expect(within(panel).getByText('First Go Around')).toBeTruthy();
    expect(within(panel).getByText(checklist[10].label)).toBeTruthy();
    expect(within(panel).getByText('Ask the next question.')).toBeTruthy();
    expect(within(panel).getByText('Pause and address the concern.')).toBeTruthy();
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

  it('preserves collapse behavior without dropping checklist items', async () => {
    const { container } = render(<CoachingPanel coaching={coaching} />);
    const toggle = screen.getByRole('button', { name: /ARIA Coaching/ });

    await userEvent.click(toggle);
    expect(container.querySelector('[data-coaching-checklist]')).toBeNull();
    await userEvent.click(toggle);
    expect(container.querySelectorAll('[data-coaching-checklist-item]')).toHaveLength(11);
  });
});
