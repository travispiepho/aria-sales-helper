import React, { useState } from 'react';
import type { Meeting, ScheduledMeetingInput, ScheduledMeetingType } from '../lib/api';
import { defaultScheduledLocal, SCHEDULE_TIME_ZONE, scheduledLocalFromIso } from '../lib/scheduleTime';

interface Props {
  type: ScheduledMeetingType;
  initial?: Meeting | null;
  onSubmit: (input: ScheduledMeetingInput) => Promise<void>;
  submitLabel?: string;
}

export default function ScheduledMeetingForm({ type, initial, onSubmit, submitLabel = 'Schedule Meeting' }: Props) {
  const [form, setForm] = useState({
    scheduled_local: initial?.scheduled_for ? scheduledLocalFromIso(initial.scheduled_for) : defaultScheduledLocal(),
    title: initial?.title || '',
    customer_name: initial?.scheduled_customer_name || '',
    customer_phone: initial?.scheduled_customer_phone || '',
    customer_address: initial?.scheduled_customer_address || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm((value) => ({ ...value, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSubmit({ ...form, channel: type, timezone: SCHEDULE_TIME_ZONE });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this meeting.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Scheduled meeting details" onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-4">
      {error && <div role="alert" className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">{error}</div>}
      <div>
        <label htmlFor="scheduled-time" className="block text-sm font-medium text-gray-700 mb-1">Date and time</label>
        <input id="scheduled-time" type="datetime-local" required value={form.scheduled_local} onChange={set('scheduled_local')} className="w-full rounded-xl border border-gray-300 px-4 py-3" />
        <p className="text-xs text-gray-500 mt-1">Grand Haven time (Eastern, America/Detroit). Daylight-saving changes are validated when saved.</p>
      </div>
      <div>
        <label htmlFor="schedule-title" className="block text-sm font-medium text-gray-700 mb-1">Meeting title</label>
        <input id="schedule-title" required maxLength={160} value={form.title} onChange={set('title')} placeholder={type === 'phone' ? 'Exterior painting follow-up' : 'On-site estimate'} className="w-full rounded-xl border border-gray-300 px-4 py-3" />
      </div>
      <div>
        <label htmlFor="schedule-customer" className="block text-sm font-medium text-gray-700 mb-1">Customer or contact name</label>
        <input id="schedule-customer" required value={form.customer_name} onChange={set('customer_name')} placeholder="Jane Smith" className="w-full rounded-xl border border-gray-300 px-4 py-3" />
      </div>
      {type === 'phone' && <div>
        <label htmlFor="schedule-phone" className="block text-sm font-medium text-gray-700 mb-1">Customer phone</label>
        <input id="schedule-phone" type="tel" required value={form.customer_phone} onChange={set('customer_phone')} placeholder="(616) 555-1234" className="w-full rounded-xl border border-gray-300 px-4 py-3" />
      </div>}
      {type === 'in_person' && <div>
        <label htmlFor="schedule-address" className="block text-sm font-medium text-gray-700 mb-1">Visit address <span className="font-normal text-gray-400">(optional)</span></label>
        <input id="schedule-address" value={form.customer_address} onChange={set('customer_address')} placeholder="123 Main St, Grand Haven, MI" className="w-full rounded-xl border border-gray-300 px-4 py-3" />
      </div>}
      <button type="submit" disabled={saving} className="w-full min-h-11 bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-3 rounded-xl">
        {saving ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
