// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
