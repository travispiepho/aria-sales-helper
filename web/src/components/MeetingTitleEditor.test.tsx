// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeetingTitleEditor from './MeetingTitleEditor';

function renderEditor(overrides: Partial<React.ComponentProps<typeof MeetingTitleEditor>> = {}) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  render(
    <MeetingTitleEditor
      value="Original title"
      savedValue="Original title"
      saving={false}
      onChange={onChange}
      onSave={onSave}
      {...overrides}
    />
  );
  return { onChange, onSave };
}

afterEach(cleanup);

describe('MeetingTitleEditor', () => {
  it('submits exactly once from the Save button when a valid title is dirty', async () => {
    const onSave = vi.fn();
    renderEditor({ value: 'Renamed browser call', onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('does not submit on blur, preventing the old blur/click duplicate race', async () => {
    const onSave = vi.fn();
    renderEditor({ value: 'Renamed browser call', onSave });
    await userEvent.click(screen.getByRole('textbox', { name: 'Meeting title' }));
    await userEvent.tab();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only titles and displays a visible error', async () => {
    const onSave = vi.fn();
    renderEditor({ value: '   ', onSave });
    const input = screen.getByRole('textbox', { name: 'Meeting title' });
    await userEvent.click(input);
    await userEvent.tab();
    expect(screen.getByRole('alert').textContent).toContain('Title cannot be empty');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables Save while unchanged or saving and reports API failures', () => {
    const { rerender } = render(
      <MeetingTitleEditor value="Same" savedValue="Same" saving={false} error={null} onChange={vi.fn()} onSave={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    rerender(
      <MeetingTitleEditor value="Changed" savedValue="Same" saving error="Meeting is still being created. Try again." onChange={vi.fn()} onSave={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('still being created');
  });
});
