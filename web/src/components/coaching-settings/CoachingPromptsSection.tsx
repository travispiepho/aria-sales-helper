import React, { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { hasAdminAccess } from '../../lib/roles';
import {
  CoachingPromptRecord,
  listCoachingPrompts,
  updateCoachingPrompt,
} from '../../lib/api';

// CoachingPromptsSection — new (2026-08-30,
// aria_coaching_settings_merge_objections_frontend). Frontend for the LLM
// coaching-prompt editor whose backend shipped as
// aria_coaching_settings_prompt_editor_backend (commit 00fcbe7): reps see
// the 6 prompts driving ARIA's coaching engine (Real-Time Coaching,
// Setup-Call Coaching, BANT, Insider Language, Question Gaps, Rebuttal)
// read-only, admins/owner get an inline edit affordance — mirroring the
// established view->edit->save toggle pattern from
// CustomerInfoSection.tsx / ObjectionsSection.tsx's ObjectionDetail,
// rather than inventing a new UI paradigm. Server enforces GET as
// any-authenticated-user, PUT as admin-only (hasAdminAccess()) — this
// component's admin gate is just the matching UX affordance, same
// "server is the real boundary" spirit as SalesStagesSection.tsx.
//
// Validation: server 400s an empty/near-empty (<20 char) prompt_text —
// surfaced here as an inline error under the textarea rather than a
// silent failure, since accidentally shipping a broken/empty system
// prompt to every rep's next coaching tick is the exact failure mode the
// backend's MIN_PROMPT_LENGTH guard exists to catch.

export default function CoachingPromptsSection() {
  const { user } = useAuth();
  const isAdmin = hasAdminAccess(user?.role);

  const [prompts, setPrompts] = useState<CoachingPromptRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const { prompts: list } = await listCoachingPrompts();
      setPrompts(list);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  function handleSaved(updated: CoachingPromptRecord) {
    setPrompts((prev) => prev.map((p) => (p.key === updated.key ? updated : p)));
  }

  return (
    <div data-coaching-settings-section="prompts">
      <p className="text-sm text-gray-500 mb-4">
        The system prompts ARIA's coaching engine sends to the LLM during a live call.
        {!isAdmin && ' Ask an admin to make changes.'}
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load coaching prompts</p>
          <button
            onClick={load}
            className="mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
          >
            Retry
          </button>
        </div>
      ) : prompts.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
          <div className="text-3xl mb-2">📝</div>
          <p className="text-gray-500 text-sm">No coaching prompts configured yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {prompts.map((p) => (
            <PromptCard key={p.key} prompt={p} isAdmin={isAdmin} onSaved={handleSaved} />
          ))}
        </div>
      )}
    </div>
  );
}

function PromptCard({
  prompt,
  isAdmin,
  onSaved,
}: {
  prompt: CoachingPromptRecord;
  isAdmin: boolean;
  onSaved: (updated: CoachingPromptRecord) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(prompt.prompt_text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (!editing) setText(prompt.prompt_text);
  }, [prompt.prompt_text, editing]);

  function startEdit() {
    setError('');
    setFlash('');
    setText(prompt.prompt_text);
    setEditing(true);
  }

  function cancelEdit() {
    setError('');
    setText(prompt.prompt_text);
    setEditing(false);
  }

  async function handleSave() {
    setError('');
    setSaving(true);
    try {
      const updated = await updateCoachingPrompt(prompt.key, text);
      onSaved(updated);
      setEditing(false);
      setFlash('✅ Saved.');
      setTimeout(() => setFlash(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prompt');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-coaching-prompt-key={prompt.key}
      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4"
    >
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 truncate">{prompt.label}</h3>
          <p className="text-xs text-gray-400 font-mono truncate">{prompt.key}</p>
        </div>
        {isAdmin && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="flex-shrink-0 text-xs font-medium text-brand-700 hover:text-brand-800 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
          >
            ✏️ Edit
          </button>
        )}
      </div>

      {flash && <div className="bg-green-50 text-green-800 rounded-xl px-3 py-2 text-xs mb-2">{flash}</div>}
      {error && (
        <div role="alert" className="bg-red-50 text-red-700 rounded-xl px-3 py-2 text-xs mb-2">
          {error}
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <textarea
            aria-label={`${prompt.label} prompt text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            disabled={saving}
            className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent disabled:bg-gray-50"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !text.trim()}
              className="flex-1 bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              disabled={saving}
              className="flex-1 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-semibold py-2.5 rounded-xl transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-600 font-mono whitespace-pre-wrap line-clamp-4">
          {prompt.prompt_text}
        </p>
      )}
    </div>
  );
}
