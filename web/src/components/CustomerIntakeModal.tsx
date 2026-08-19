import React, { useState } from 'react';
import { createCustomer } from '../lib/api';

interface Props {
  onClose: () => void;
  onCreated: (customerId: string, title: string) => void;
}

export default function CustomerIntakeModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    name: '',
    address: '',
    phone: '',
    email: '',
    source: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm(f => ({ ...f, [field]: e.target.value }));
    };
  }

  function generateTitle(): string {
    const address = form.address.trim();
    const name = form.name.trim();
    if (address) return address;
    if (name) return `Conversation with ${name}`;
    return 'Unnamed conversation';
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const customer = await createCustomer({
        name: form.name.trim() || 'Unknown',
        address: form.address.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        source: form.source.trim() || undefined,
      });
      onCreated(customer.id, generateTitle());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create customer');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white px-5 pt-5 pb-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">New Customer</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
          {error && (
            <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={set('name')}
              placeholder="Jane Smith"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address
            </label>
            <input
              type="text"
              value={form.address}
              onChange={set('address')}
              placeholder="123 Main St, Grand Haven, MI"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              placeholder="(616) 555-1234"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="customer@email.com"
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Lead Source
            </label>
            <select
              value={form.source}
              onChange={set('source')}
              className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent bg-white"
            >
              <option value="">Select source…</option>
              <option value="referral">Referral</option>
              <option value="meta_ads">Meta Ads (Facebook/Instagram)</option>
              <option value="certapro_corporate">CertaPro Corporate</option>
              <option value="google">Google</option>
              <option value="door_hanger">Door Hanger</option>
              <option value="yard_sign">Yard Sign</option>
              <option value="repeat">Repeat Customer</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="pt-2 pb-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-4 rounded-xl transition-colors text-lg"
            >
              {loading ? 'Saving…' : 'Save & Start Meeting'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
