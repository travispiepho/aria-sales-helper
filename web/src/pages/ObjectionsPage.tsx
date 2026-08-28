import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Objection,
  ObjectionWithRebuttals,
  Rebuttal,
  listObjections,
  getObjection,
  createObjection,
  updateObjection,
  deleteObjection,
  createRebuttal,
  updateRebuttal,
  deleteRebuttal,
} from '../lib/api';
import AppPageLayout from '../components/AppPageLayout';

// ObjectionsPage — new "Objections" tab (2026-08-18), Troy Hacker's request
// (tracked as "Rebuttal list to objections" in HighPriorityTodos). A
// standalone reference library: browse a shared list of customer
// objections, drill into one to read/add rebuttals other reps have found
// effective. See server.js's route-block comment for the shared (not
// per-rep-scoped, not admin-gated) auth model this mirrors.
//
// Two-pane-on-one-screen pattern (list view <-> detail view, toggled by
// state rather than a nested route) — same approach SchedulePage.tsx /
// ScheduleVisitPage.tsx use for their own single-purpose screens, kept
// simple since this tab doesn't need deep-linkable detail URLs yet.

type View = { mode: 'list' } | { mode: 'detail'; id: string };

export default function ObjectionsPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>({ mode: 'list' });

  return view.mode === 'list' ? (
    <ObjectionsList onOpen={(id) => setView({ mode: 'detail', id })} onBack={() => navigate('/')} />
  ) : (
    <ObjectionDetail id={view.id} onBack={() => setView({ mode: 'list' })} />
  );
}

// ─── List view ──────────────────────────────────────────────────────────────

function ObjectionsList({ onOpen, onBack }: { onOpen: (id: string) => void; onBack: () => void }) {
  const [objections, setObjections] = useState<Objection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newText, setNewText] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const list = await listObjections();
      setObjections(list);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return objections;
    return objections.filter(
      (o) =>
        o.text.toLowerCase().includes(q) ||
        (o.category || '').toLowerCase().includes(q)
    );
  }, [objections, query]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newText.trim()) return;
    setSaving(true);
    setSaveError('');
    try {
      const created = await createObjection(newText.trim(), newCategory.trim() || undefined);
      setObjections((prev) => [{ ...created, rebuttal_count: 0 }, ...prev]);
      setNewText('');
      setNewCategory('');
      setShowAdd(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to add objection');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppPageLayout
      title="Objections"
      subtitle="Browse common customer objections and the rebuttals that work."
      onBack={onBack}
      contentClassName="max-w-lg mx-auto"
    >
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search objections…"
            aria-label="Search objections"
            className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
        </div>

        <button
          onClick={() => setShowAdd((s) => !s)}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition-colors mb-4"
        >
          {showAdd ? 'Cancel' : '+ Add Objection'}
        </button>

        {showAdd && (
          <form onSubmit={handleAdd} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 mb-4 space-y-3">
            {saveError && (
              <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">{saveError}</div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Objection</label>
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder={'e.g. "Your price is higher than the other quote I got"'}
                rows={2}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category (optional)</label>
              <input
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="e.g. Price, Timing, Trust"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
            </div>
            <button
              type="submit"
              disabled={saving || !newText.trim()}
              className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              {saving ? 'Saving…' : 'Save Objection'}
            </button>
          </form>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
            <div className="text-3xl mb-2">⚠️</div>
            <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load objections</p>
            <button
              onClick={load}
              className="mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="text-3xl mb-2">💬</div>
            <p className="text-gray-500 text-sm">
              {objections.length === 0 ? 'No objections yet — add the first one.' : 'No objections match your search.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((o) => (
              <button
                key={o.id}
                onClick={() => onOpen(o.id)}
                className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-left hover:border-brand-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-gray-900">{o.text}</p>
                  <span className="flex-shrink-0 text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
                    {o.rebuttal_count ?? 0} {o.rebuttal_count === 1 ? 'rebuttal' : 'rebuttals'}
                  </span>
                </div>
                {o.category && (
                  <p className="text-xs text-brand-600 font-medium mt-1 uppercase tracking-wide">{o.category}</p>
                )}
              </button>
            ))}
          </div>
        )}
    </AppPageLayout>
  );
}

// ─── Detail view ────────────────────────────────────────────────────────────

function ObjectionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [objection, setObjection] = useState<ObjectionWithRebuttals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [editingObjection, setEditingObjection] = useState(false);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [savingObjection, setSavingObjection] = useState(false);

  const [newRebuttal, setNewRebuttal] = useState('');
  const [addingRebuttal, setAddingRebuttal] = useState(false);
  const [rebuttalError, setRebuttalError] = useState('');

  const [editingRebuttalId, setEditingRebuttalId] = useState<string | null>(null);
  const [editRebuttalText, setEditRebuttalText] = useState('');
  const [savingRebuttalId, setSavingRebuttalId] = useState<string | null>(null);
  const [deletingRebuttalId, setDeletingRebuttalId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [id]);

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const o = await getObjection(id);
      setObjection(o);
      setEditText(o.text);
      setEditCategory(o.category || '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveObjection() {
    if (!objection || !editText.trim()) return;
    setSavingObjection(true);
    try {
      const updated = await updateObjection(objection.id, {
        text: editText.trim(),
        category: editCategory.trim() || null,
      });
      setObjection({ ...objection, ...updated });
      setEditingObjection(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update objection');
    } finally {
      setSavingObjection(false);
    }
  }

  async function handleDeleteObjection() {
    if (!objection) return;
    if (!confirm('Delete this objection and all of its rebuttals? This cannot be undone.')) return;
    try {
      await deleteObjection(objection.id);
      onBack();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete objection');
    }
  }

  async function handleAddRebuttal(e: React.FormEvent) {
    e.preventDefault();
    if (!objection || !newRebuttal.trim()) return;
    setAddingRebuttal(true);
    setRebuttalError('');
    try {
      const created = await createRebuttal(objection.id, newRebuttal.trim());
      setObjection({ ...objection, rebuttals: [...objection.rebuttals, created] });
      setNewRebuttal('');
    } catch (err) {
      setRebuttalError(err instanceof Error ? err.message : 'Failed to add rebuttal');
    } finally {
      setAddingRebuttal(false);
    }
  }

  function startEditRebuttal(r: Rebuttal) {
    setEditingRebuttalId(r.id);
    setEditRebuttalText(r.text);
  }

  async function handleSaveRebuttal(r: Rebuttal) {
    if (!objection || !editRebuttalText.trim()) return;
    setSavingRebuttalId(r.id);
    try {
      const updated = await updateRebuttal(r.id, editRebuttalText.trim());
      setObjection({
        ...objection,
        rebuttals: objection.rebuttals.map((x) => (x.id === r.id ? updated : x)),
      });
      setEditingRebuttalId(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update rebuttal');
    } finally {
      setSavingRebuttalId(null);
    }
  }

  async function handleDeleteRebuttal(r: Rebuttal) {
    if (!objection) return;
    if (!confirm('Delete this rebuttal?')) return;
    setDeletingRebuttalId(r.id);
    try {
      await deleteRebuttal(r.id);
      setObjection({ ...objection, rebuttals: objection.rebuttals.filter((x) => x.id !== r.id) });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete rebuttal');
    } finally {
      setDeletingRebuttalId(null);
    }
  }

  return (
    <AppPageLayout
      title="Objection"
      onBack={onBack}
      backLabel="Back to Objections"
      contentClassName="max-w-lg mx-auto"
    >
      {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
          </div>
        ) : loadError || !objection ? (
          <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
            <div className="text-3xl mb-2">⚠️</div>
            <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load this objection</p>
            <button
              onClick={load}
              className="mt-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-4">
              {editingObjection ? (
                <div className="space-y-3">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                    className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  />
                  <input
                    type="text"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="Category (optional)"
                    className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveObjection}
                      disabled={savingObjection || !editText.trim()}
                      className="flex-1 bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl transition-colors"
                    >
                      {savingObjection ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditingObjection(false)}
                      className="flex-1 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-semibold py-2.5 rounded-xl transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold text-gray-900 text-lg">{objection.text}</p>
                  </div>
                  {objection.category && (
                    <p className="text-xs text-brand-600 font-medium mt-1 uppercase tracking-wide">
                      {objection.category}
                    </p>
                  )}
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => setEditingObjection(true)}
                      className="text-sm font-medium text-gray-600 hover:text-brand-700 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      ✏️ Edit
                    </button>
                    <button
                      onClick={handleDeleteObjection}
                      className="text-sm font-medium text-red-500 hover:text-red-700 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-colors"
                    >
                      🗑 Delete
                    </button>
                  </div>
                </>
              )}
            </div>

            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Rebuttals
            </h2>

            {objection.rebuttals.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center mb-4">
                <p className="text-gray-500 text-sm">No rebuttals yet — add one below.</p>
              </div>
            ) : (
              <div className="space-y-3 mb-4">
                {objection.rebuttals.map((r) => (
                  <div key={r.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
                    {editingRebuttalId === r.id ? (
                      <div className="space-y-3">
                        <textarea
                          value={editRebuttalText}
                          onChange={(e) => setEditRebuttalText(e.target.value)}
                          rows={2}
                          className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSaveRebuttal(r)}
                            disabled={savingRebuttalId === r.id || !editRebuttalText.trim()}
                            className="flex-1 bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-2 rounded-xl transition-colors text-sm"
                          >
                            {savingRebuttalId === r.id ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingRebuttalId(null)}
                            className="flex-1 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-semibold py-2 rounded-xl transition-colors text-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="text-gray-800 text-sm">{r.text}</p>
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={() => startEditRebuttal(r)}
                            className="text-xs font-medium text-gray-600 hover:text-brand-700 px-2 py-1 rounded-lg hover:bg-gray-50 transition-colors"
                          >
                            ✏️ Edit
                          </button>
                          <button
                            onClick={() => handleDeleteRebuttal(r)}
                            disabled={deletingRebuttalId === r.id}
                            className="text-xs font-medium text-red-500 hover:text-red-700 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                          >
                            {deletingRebuttalId === r.id ? '…' : '🗑 Delete'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleAddRebuttal} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-3">
              {rebuttalError && (
                <div className="bg-red-50 text-red-700 rounded-xl px-4 py-3 text-sm">{rebuttalError}</div>
              )}
              <label className="block text-sm font-medium text-gray-700">Add a rebuttal</label>
              <textarea
                value={newRebuttal}
                onChange={(e) => setNewRebuttal(e.target.value)}
                placeholder="What's worked for you here?"
                rows={2}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={addingRebuttal || !newRebuttal.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors"
              >
                {addingRebuttal ? 'Saving…' : '+ Add Rebuttal'}
              </button>
            </form>
          </>
        )}
    </AppPageLayout>
  );
}
