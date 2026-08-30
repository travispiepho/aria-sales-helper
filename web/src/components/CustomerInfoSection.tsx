import React, { useEffect, useState } from 'react';
import { Customer, updateCustomer } from '../lib/api';

// 2026-08-29 (aria_customer_info_editable_section). Shared between
// MeetingPage.tsx (in-person + phone meetings) and UploadedRecordingPage.tsx
// (uploaded-recording meetings) so the "Customer Info" block that renders
// directly under each page's title+type row / duration row (both left-
// column blocks introduced by the aria_left_panel_title_type_duration and
// aria_active_meeting_banner_info_left_panel tasks) is one implementation,
// not three near-duplicate copies of the same form markup.
//
// Edit-affordance pattern deliberately mirrors the existing inline
// view/edit toggle already used by ObjectionsPage.tsx's ObjectionDetail
// (view mode with an "✏️ Edit" button → edit mode with text inputs and
// Save/Cancel), rather than inventing a new visual pattern — this app's
// existing convention for "edit an existing record in place" is that
// toggle, not a separate modal (CustomerIntakeModal.tsx's modal is
// specifically a CREATE flow tied to starting a new meeting, not a fit for
// editing an already-linked customer mid-meeting).
//
// No-customer-linked case: `customerId` is undefined/null whenever a
// meeting has no linked customer row (verified live — POST /api/meetings
// and createUploadedRecordingMeeting() both accept an optional
// customer_id and every current caller of the uploaded-recording path
// passes none at all, and telephony.js's resolveCustomerByPhone() can
// legitimately return no match for an unrecognized caller). Rather than
// inventing a new "link an existing customer to this meeting" flow (out of
// scope for this task — no such endpoint exists, and adding one is a much
// bigger change than "edit the customer already on this meeting"), this
// component renders a small, clearly-labeled placeholder card in that case
// so the surrounding layout never has a broken/empty edit form and the rep
// still gets an explanation instead of nothing.

export interface CustomerInfoSectionProps {
  customerId?: string | null;
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  onSaved?: (customer: Customer) => void;
}

interface EditForm {
  name: string;
  address: string;
  phone: string;
  email: string;
}

function toForm(props: CustomerInfoSectionProps): EditForm {
  return {
    name: props.name || '',
    address: props.address || '',
    phone: props.phone || '',
    email: props.email || '',
  };
}

export default function CustomerInfoSection(props: CustomerInfoSectionProps) {
  const { customerId } = props;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(() => toForm(props));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the view (non-editing) form in sync with fresh parent data (e.g.
  // after the parent's own getMeeting() reload, or another session's edit
  // arriving via a future sync push) — but never clobber in-flight,
  // unsaved edits the rep is actively typing.
  useEffect(() => {
    if (!editing) setForm(toForm(props));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.name, props.address, props.phone, props.email, customerId]);

  function set(field: keyof EditForm) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm(f => ({ ...f, [field]: e.target.value }));
    };
  }

  function startEdit() {
    setError(null);
    setForm(toForm(props));
    setEditing(true);
  }

  function cancelEdit() {
    setError(null);
    setForm(toForm(props));
    setEditing(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) return;
    const trimmedName = form.name.trim();
    if (!trimmedName) {
      setError('Name cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCustomer(customerId, {
        name: trimmedName,
        address: form.address.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
      });
      setEditing(false);
      props.onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save customer info.');
    } finally {
      setSaving(false);
    }
  }

  if (!customerId) {
    return (
      <div
        data-customer-info-section="empty"
        className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4"
      >
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
          Customer Info
        </h3>
        <p className="text-sm text-gray-500">No customer linked to this meeting yet.</p>
      </div>
    );
  }

  return (
    <div data-customer-info-section="editable" className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Customer Info
        </h3>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="text-xs font-medium text-brand-700 hover:text-brand-800"
          >
            ✏️ Edit
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="bg-red-50 text-red-700 rounded-xl px-3 py-2 text-xs mb-3">
          {error}
        </div>
      )}

      {editing ? (
        <form onSubmit={handleSave} className="space-y-2">
          <input
            aria-label="Customer name"
            type="text"
            value={form.name}
            onChange={set('name')}
            placeholder="Name"
            disabled={saving}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
          />
          <input
            aria-label="Customer address"
            type="text"
            value={form.address}
            onChange={set('address')}
            placeholder="Address"
            disabled={saving}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
          />
          <input
            aria-label="Customer phone"
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            placeholder="Phone"
            disabled={saving}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
          />
          <input
            aria-label="Customer email"
            type="email"
            value={form.email}
            onChange={set('email')}
            placeholder="Email"
            disabled={saving}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
          />
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || !form.name.trim()}
              className="flex-1 bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-2 rounded-lg text-sm transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="flex-1 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-semibold py-2 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-1.5 text-sm">
          <div className="font-medium text-gray-900">{props.name || 'Unnamed customer'}</div>
          {props.address && <div className="text-gray-600">{props.address}</div>}
          {props.phone && <div className="text-gray-600">{props.phone}</div>}
          {props.email && <div className="text-gray-600">{props.email}</div>}
        </div>
      )}
    </div>
  );
}
