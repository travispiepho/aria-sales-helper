import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { hasAdminAccess } from '../lib/roles';
import {
  CoachingStageRecord,
  listCoachingStages,
  createCoachingStage,
  deleteCoachingStage,
} from '../lib/api';
import AppPageLayout from '../components/AppPageLayout';

// CoachingStagesPage — new "Coaching" tab (2026-08-30,
// aria_coaching_stages_admin_tab). Displays the full list of sales-process
// stages the live coaching engine tracks a call's progress through (Setup
// Call -> Follow Up) -- visible to ALL logged-in users, same spirit as the
// Objections tab (reps should be able to see what stages exist even though
// they can't edit them). Admin-only add/remove controls are gated on
// hasAdminAccess() (role 'admin' or 'owner'), matching the established
// pattern in AdminUsersPage.tsx / ObjectionsPage.tsx: the server is the
// real security boundary (POST/DELETE both 403 non-admins), this page's
// gate is just the matching UX affordance.
//
// Unlike ObjectionsPage.tsx's shared-for-everyone add/edit/delete model,
// this list's ORDER is load-bearing (CoachingPanel.tsx's stage-progress
// percentage is stageIndex / stages.length, sourced from this same table),
// so edit capability is intentionally admin-only here -- see
// coachingStages.js's route-block comment in server.js for the full auth
// rationale. New stages are appended to the end of the order (no reorder
// UI in this pass -- see the "Reordering" note in the empty-state/footer
// text below for the explicit follow-up recommendation left for a later
// pass).

const KEY_RE = /^[a-z][a-z0-9_]*$/;

export default function CoachingStagesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = hasAdminAccess(user?.role);

  const [stages, setStages] = useState<CoachingStageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [keyFieldError, setKeyFieldError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deleteFlash, setDeleteFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const { stages: list } = await listCoachingStages();
      setStages(list);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setKeyFieldError('');
    setSaveError('');

    const trimmedKey = newKey.trim();
    const trimmedLabel = newLabel.trim();

    if (!trimmedKey) {
      setKeyFieldError('Enter a machine-safe key.');
      return;
    }
    if (!KEY_RE.test(trimmedKey)) {
      setKeyFieldError('Lowercase letters, numbers, and underscores only, starting with a letter (e.g. "site_walkthrough").');
      return;
    }
    if (!trimmedLabel) {
      setSaveError('Enter a display label.');
      return;
    }

    setSaving(true);
    try {
      const created = await createCoachingStage(trimmedKey, trimmedLabel);
      setStages((prev) => [...prev, created]);
      setNewKey('');
      setNewLabel('');
      setShowAdd(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to add stage');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(stageToDelete: CoachingStageRecord) {
    const msg =
      `Remove "${stageToDelete.label}" (${stageToDelete.key}) from the stage list?\n\n` +
      `Reps will no longer see this stage tracked during live coaching. ` +
      `Historical meetings that already reached this stage keep their own ` +
      `saved record of it and are not affected.`;
    if (!confirm(msg)) return;

    setDeletingKey(stageToDelete.key);
    setDeleteFlash(null);
    try {
      const result = await deleteCoachingStage(stageToDelete.key);
      setStages((prev) => prev.filter((s) => s.key !== stageToDelete.key));
      if (result.historical_usage_count > 0) {
        setDeleteFlash({
          type: 'success',
          text: `✅ Removed "${stageToDelete.label}". Note: ${result.historical_usage_count} past meeting${result.historical_usage_count === 1 ? '' : 's'} already recorded reaching this stage — those historical records are unchanged.`,
        });
      } else {
        setDeleteFlash({ type: 'success', text: `✅ Removed "${stageToDelete.label}".` });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Failed to remove stage';
      setDeleteFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <AppPageLayout
      title="Coaching"
      subtitle="The sales-process stages ARIA tracks during a live call."
      onBack={() => navigate('/')}
      contentClassName="max-w-lg mx-auto"
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load coaching stages</p>
          <button
            onClick={load}
            className="mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {isAdmin && (
            <button
              onClick={() => setShowAdd((s) => !s)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors mb-4"
            >
              {showAdd ? 'Cancel' : '+ Add Stage'}
            </button>
          )}

          {isAdmin && showAdd && (
            <form onSubmit={handleAdd} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-4 space-y-3">
              {saveError && (
                <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">{saveError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Key</label>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => {
                    setNewKey(e.target.value);
                    if (keyFieldError) setKeyFieldError('');
                  }}
                  placeholder="e.g. site_walkthrough"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
                {keyFieldError && <p className="text-xs text-red-600 mt-1">{keyFieldError}</p>}
                <p className="text-xs text-gray-400 mt-1">
                  Machine-safe identifier: lowercase letters, numbers, underscores only. Must be unique.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. Site Walkthrough"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
              <p className="text-xs text-gray-400">
                New stages are added to the end of the list — reordering isn't supported yet.
              </p>
              <button
                type="submit"
                disabled={saving || !newKey.trim() || !newLabel.trim()}
                className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                {saving ? 'Saving…' : 'Save Stage'}
              </button>
            </form>
          )}

          {deleteFlash && (
            <div
              className={`rounded-2xl px-4 py-3 mb-4 text-sm ${
                deleteFlash.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              {deleteFlash.text}
            </div>
          )}

          {stages.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
              <div className="text-3xl mb-2">🧭</div>
              <p className="text-gray-500 text-sm">No coaching stages configured yet.</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <ul className="divide-y divide-gray-100">
                {stages.map((s, index) => (
                  <li key={s.id} className="px-5 py-4 flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                      {index + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{s.label}</p>
                      <p className="text-xs text-gray-400 font-mono truncate">{s.key}</p>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => handleDelete(s)}
                        disabled={deletingKey === s.key}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        {deletingKey === s.key ? 'Removing…' : '🗑 Remove'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!isAdmin && (
            <p className="text-xs text-gray-400 text-center mt-4">
              Ask an admin to add or remove a stage.
            </p>
          )}
        </>
      )}
    </AppPageLayout>
  );
}
