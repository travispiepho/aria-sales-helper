// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomerInfoSection from './CustomerInfoSection';

const mocks = vi.hoisted(() => ({ updateCustomer: vi.fn() }));
vi.mock('../lib/api', () => ({ updateCustomer: mocks.updateCustomer }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('CustomerInfoSection', () => {
  it('renders a graceful empty state when no customer is linked (no crash, no broken form)', () => {
    render(<CustomerInfoSection customerId={undefined} />);
    expect(screen.getByText('No customer linked to this meeting yet.')).toBeTruthy();
    expect(document.querySelector('[data-customer-info-section="empty"]')).toBeTruthy();
    expect(document.querySelector('[data-customer-info-section="editable"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '✏️ Edit' })).toBeNull();
  });

  it('renders view mode with the linked customer fields and an Edit affordance', () => {
    render(
      <CustomerInfoSection
        customerId="cust-1"
        name="Jane Smith"
        address="123 Main St"
        phone="6165551212"
        email="jane@example.com"
      />
    );
    expect(document.querySelector('[data-customer-info-section="editable"]')).toBeTruthy();
    expect(screen.getByText('Jane Smith')).toBeTruthy();
    expect(screen.getByText('123 Main St')).toBeTruthy();
    expect(screen.getByText('6165551212')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: '✏️ Edit' })).toBeTruthy();
  });

  it('falls back to "Unnamed customer" when a customer is linked but has no name yet', () => {
    render(<CustomerInfoSection customerId="cust-1" name={null} />);
    expect(screen.getByText('Unnamed customer')).toBeTruthy();
  });

  it('toggles into edit mode, saves via updateCustomer, and reflects the update without a reload', async () => {
    const user = userEvent.setup();
    mocks.updateCustomer.mockResolvedValue({
      id: 'cust-1',
      name: 'Jane Doe',
      address: '123 Main St',
      phone: '6165551212',
      email: 'jane@example.com',
      created_at: new Date().toISOString(),
    });
    const onSaved = vi.fn();
    render(
      <CustomerInfoSection
        customerId="cust-1"
        name="Jane Smith"
        address="123 Main St"
        phone="6165551212"
        email="jane@example.com"
        onSaved={onSaved}
      />
    );

    await user.click(screen.getByRole('button', { name: '✏️ Edit' }));
    const nameInput = screen.getByLabelText('Customer name') as HTMLInputElement;
    expect(nameInput.value).toBe('Jane Smith');
    await user.clear(nameInput);
    await user.type(nameInput, 'Jane Doe');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.updateCustomer).toHaveBeenCalledWith('cust-1', {
      name: 'Jane Doe',
      address: '123 Main St',
      phone: '6165551212',
      email: 'jane@example.com',
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe' })));
    // Back to view mode after a successful save — no lingering form.
    await waitFor(() => expect(screen.queryByLabelText('Customer name')).toBeNull());
  });

  it('shows a validation error and does not call updateCustomer when name is cleared to empty', async () => {
    const user = userEvent.setup();
    render(<CustomerInfoSection customerId="cust-1" name="Jane Smith" />);
    await user.click(screen.getByRole('button', { name: '✏️ Edit' }));
    const nameInput = screen.getByLabelText('Customer name');
    await user.clear(nameInput);
    // Submit the form directly (the Save button is disabled once the trimmed
    // name is empty, matching MeetingTitleEditor's own disabled-when-empty
    // convention) — this proves the component's own handleSave guard (not
    // just the disabled attribute) rejects an empty name.
    const form = nameInput.closest('form')!;
    fireEvent.submit(form);
    const alertEl = await screen.findByRole('alert');
    expect(alertEl.textContent).toBe('Name cannot be empty.');
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });

  it('surfaces a save error inline and stays in edit mode (no silent failure)', async () => {
    const user = userEvent.setup();
    mocks.updateCustomer.mockRejectedValue(new Error('Network error'));
    render(<CustomerInfoSection customerId="cust-1" name="Jane Smith" />);
    await user.click(screen.getByRole('button', { name: '✏️ Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alertEl = await screen.findByRole('alert');
    expect(alertEl.textContent).toBe('Network error');
    // Still in edit mode — the form did not silently vanish on failure.
    expect(screen.getByLabelText('Customer name')).toBeTruthy();
  });

  it('Cancel discards edits and returns to view mode without saving', async () => {
    const user = userEvent.setup();
    render(<CustomerInfoSection customerId="cust-1" name="Jane Smith" />);
    await user.click(screen.getByRole('button', { name: '✏️ Edit' }));
    const nameInput = screen.getByLabelText('Customer name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Someone Else');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
    expect(screen.getByText('Jane Smith')).toBeTruthy();
    expect(screen.queryByText('Someone Else')).toBeNull();
  });
});
