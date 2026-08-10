import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listAdminUsers, deleteAdminUser, AdminUser } from '../lib/api';

// AdminUsersPage — 2026-08-10.
//
// Minimal admin-only account list, currently exposing DELETE (soft-delete
// via DELETE /api/admin/users/:id). The queued follow-up task will add
// "add new account" on this same page; that flow deliberately isn't
// wired up here yet to keep this ship-piece focused on the delete flow.
//
// UI patterns intentionally mirror ProfilePage.tsx: brand-700 header
// with back arrow, rounded-2xl cards on gray-50, red destructive style
// for delete actions, native confirm() dialog for the pre-delete gate
// (matches the existing voice-print "Remove your voice enrollment?"
// pattern). Non-admins who somehow reach /admin/users get a friendly
// 403 explanation instead of an empty page — the server also enforces
// this, so hand-crafting a URL doesn't leak anything.
export default function AdminUsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const data = await listAdminUsers();
      setUsers(data.users);
    } catch (err: unknown) {
      setUsers(null);
      const msg = err instanceof Error ? err.message : 'Failed to load users';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user?.role === 'admin') {
      load();
    } else {
      setLoading(false);
    }
    // Intentionally omit `user` from deps — we only kick off the load once
    // on mount for the authenticated admin. useAuth's user reference is
    // stable across the session for our purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDelete(target: AdminUser) {
    if (target.deactivated_at) return; // already deactivated, button hidden anyway

    // Two-step confirmation: the task explicitly requires "do not delete on
    // a single click." confirm() is a hard modal browser dialog that the
    // user must actively OK, which matches ProfilePage's existing
    // destructive-action pattern (voice-print removal).
    const msg =
      `Delete account for ${target.name} <${target.email}> (${target.role})?\n\n` +
      `This will soft-delete the account:\n` +
      `  • They will no longer be able to sign in.\n` +
      `  • Any active session they have will be revoked.\n` +
      `  • Their meeting history stays intact for reporting.\n\n` +
      `This action can be reversed by clearing the deactivated_at column ` +
      `in the users table directly if needed.`;
    if (!confirm(msg)) return;

    setDeletingId(target.id);
    setFlash(null);
    try {
      const result = await deleteAdminUser(target.id);
      setFlash({
        type: 'success',
        text:
          `✅ Deleted ${result.user.name} (${result.user.email}). ` +
          `Revoked ${result.sessions_revoked} live session${result.sessions_revoked === 1 ? '' : 's'}.`,
      });
      // Reload the list so the deactivated row moves to the deactivated
      // group (or disappears from the "active" section, depending on
      // how we render below).
      await load();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Failed to delete user';
      setFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setDeletingId(null);
    }
  }

  // Non-admin fallback — friendly explanation instead of a blank page.
  // Server also returns 403 so this is a UX niceness, not a security gate.
  if (!loading && user?.role !== 'admin') {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-brand-700 text-white px-4 pt-4 pb-6 safe-top">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="text-brand-100 hover:text-white text-xl leading-none p-1"
            >
              ←
            </button>
            <h1 className="text-xl font-bold">Admin — Users</h1>
          </div>
        </div>
        <div className="px-4 py-6 max-w-lg mx-auto">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <p className="text-4xl mb-2">🔒</p>
            <p className="font-semibold text-gray-900 mb-1">Admin access required</p>
            <p className="text-sm text-gray-500">
              This page is only available to admin accounts.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const active = (users || []).filter((u) => !u.deactivated_at);
  const deactivated = (users || []).filter((u) => u.deactivated_at);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-brand-700 text-white px-4 pt-4 pb-6 safe-top">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="text-brand-100 hover:text-white text-xl leading-none p-1"
          >
            ←
          </button>
          <h1 className="text-xl font-bold">Admin — Users</h1>
        </div>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">
        {flash && (
          <div
            className={`rounded-2xl px-4 py-3 text-sm ${
              flash.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-800'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {flash.text}
          </div>
        )}

        {loading && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center text-gray-500">
            Loading users…
          </div>
        )}

        {error && !loading && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-sm text-red-600 mb-2">❌ Failed to load users: {error}</p>
            <button
              onClick={load}
              className="w-full bg-brand-700 hover:bg-brand-800 text-white font-semibold py-2 rounded-xl text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && users && (
          <>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-900">Active accounts</h2>
                <span className="text-xs text-gray-400">{active.length}</span>
              </div>
              {active.length === 0 ? (
                <p className="text-sm text-gray-500">No active accounts.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {active.map((u) => {
                    const isSelf = u.id === user?.id;
                    const isBusy = deletingId === u.id;
                    return (
                      <li key={u.id} className="py-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-brand-600 flex items-center justify-center text-white font-bold flex-shrink-0">
                          {u.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {u.name} {isSelf && <span className="text-xs text-gray-400 font-normal">(you)</span>}
                          </p>
                          <p className="text-xs text-gray-500 truncate">{u.email}</p>
                          <span
                            className={`inline-block mt-0.5 text-[10px] font-medium px-2 py-0.5 rounded-full capitalize ${
                              u.role === 'admin'
                                ? 'bg-brand-100 text-brand-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {u.role}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={isSelf || isBusy}
                          title={isSelf ? "You can't delete your own account" : 'Delete this account'}
                          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                            isSelf
                              ? 'text-gray-300 cursor-not-allowed'
                              : 'text-red-600 hover:bg-red-50'
                          } ${isBusy ? 'opacity-50' : ''}`}
                        >
                          {isBusy ? 'Deleting…' : 'Delete'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {deactivated.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-gray-500">Deactivated</h2>
                  <span className="text-xs text-gray-400">{deactivated.length}</span>
                </div>
                <ul className="divide-y divide-gray-100">
                  {deactivated.map((u) => (
                    <li key={u.id} className="py-3 flex items-center gap-3 opacity-60">
                      <div className="w-10 h-10 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold flex-shrink-0">
                        {u.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-700 truncate">{u.name}</p>
                        <p className="text-xs text-gray-500 truncate">{u.email}</p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          Deactivated{' '}
                          {u.deactivated_at
                            ? new Date(u.deactivated_at).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : '—'}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
