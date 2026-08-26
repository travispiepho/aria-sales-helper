import React, { FormEvent, useState } from 'react';

interface MeetingTitleEditorProps {
  value: string;
  savedValue?: string | null;
  placeholder?: string;
  saving: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  onSave: () => Promise<void> | void;
}

export default function MeetingTitleEditor({
  value,
  savedValue,
  placeholder = 'Add a title…',
  saving,
  error,
  onChange,
  onSave,
}: MeetingTitleEditorProps) {
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const dirty = trimmed !== (savedValue || '').trim();
  const emptyError = touched && !trimmed ? 'Title cannot be empty.' : null;
  const visibleError = emptyError || error;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (!trimmed || !dirty || saving) return;
    void onSave();
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
        Meeting Title
      </h3>
      <form className="flex gap-2" onSubmit={handleSubmit} noValidate>
        <input
          aria-label="Meeting title"
          type="text"
          value={value}
          onChange={event => {
            setTouched(false);
            onChange(event.target.value);
          }}
          onBlur={() => setTouched(true)}
          placeholder={placeholder}
          disabled={saving}
          aria-invalid={Boolean(visibleError)}
          aria-describedby={visibleError ? 'meeting-title-error' : undefined}
          className="flex-1 min-w-0 rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
        />
        <button
          type="submit"
          disabled={saving || !trimmed || !dirty}
          className="px-3 py-2 bg-brand-700 hover:bg-brand-800 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>
      {visibleError && (
        <p id="meeting-title-error" role="alert" className="mt-2 text-sm text-red-600">
          {visibleError}
        </p>
      )}
    </div>
  );
}
