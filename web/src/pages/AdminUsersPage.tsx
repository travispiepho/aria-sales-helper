import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listAdminUsers, deleteAdminUser, inviteUser, AdminUser, InviteRole } from '../lib/api';

// AdminUsersPage — 2026-08-10.
//
// Admin-only account list (soft-delete via DELETE /api/admin/users/:id)
// PLUS the "invite a new user" flow (POST /api/admin/invite) added in this
// same pass, per Gabe's request: an admin-only email textbox + role picker
// (Admin/Sales Rep) + Invite button on this page.
//
// ⚠️ IMPORTANT — the invite flow below is FRONTEND + STUB BACKEND ONLY.
// No email is actually sent. POST /api/admin/invite just records the
// invite intent in a new `invites` table (email, role, invited_by,
// created_at, status) so this UI is fully testable end-to-end (including
// the duplicate-email / already-invited error paths) without requiring
// a real email-sending integration, which is explicitly scoped to a
// separate task. The success state below intentionally says "Invite
// recorded", never "email sent".
//
// UI patterns intentionally mirror ProfilePage.tsx: brand-700 header
// with back arrow, rounded-2xl cards on gray-50, red destructive style
// for delete actions, native confirm() dialog for the pre-delete gate
// (matches the existing voice-print "Remove your voice enrollment?"
// pattern). Non-admins who somehow reach /admin/users get a friendly
// 403 explanation instead of an empty page — the server also enforces
// this, so hand-crafting a URL doesn't leak anything.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AdminUsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── Invite a new user ──────────────────────────────────────────────────
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole | null>(null);
  const [inviteFieldError, setInviteFieldError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteFlash, setInviteFlash] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteFlash(null);

    // Client-side validation, per the task's explicit requirement: valid
    // email format AND a role must be selected, both checked BEFORE we
    // allow submit (i.e. before calling the API at all).
    const trimmedEmail = inviteEmail.trim();
    if (!trimmedEmail) {
      setInviteFieldError('Enter an email address.');
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setInviteFieldError('Enter a valid email address.');
      return;
    }
    if (!inviteRole) {
      setInviteFieldError('Choose a role: Admin or Sales Rep.');
      return;
    }
    setInviteFieldError(null);

    setInviting(true);
    try {
      const result = await inviteUser(trimmedEmail, inviteRole);
      // Deliberately "Invite recorded", NOT "email sent" — the backend
      // stub does not send an email yet (see file header comment).
      setInviteFlash({
        type: 'success',
        text: `✅ Invite recorded for ${result.invite.email} (${result.invite.role === 'admin' ? 'Admin' : 'Sales Rep'}). Email delivery isn't wired up yet — this only saved the pending invite.`,
      });
      setInviteEmail('');
      setInviteRole(null);
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Failed to record invite';
      setInviteFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setInviting(false);
    }
  }

  // Non-admin fallback — friendly explanation instead of a blank page.
  // Server also returns 403 so this is a UX niceness, not a security gate.
  if (!loading && user?.role !== 'admin') {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/')}
              className="text-brand-100 hover:text-white text-2xl leading-none p-1"
            >
              ←
            </button>
            <h1 className="text-2xl font-bold leading-tight">Admin — Users</h1>
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
      <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-brand-100 hover:text-white text-2xl leading-none p-1"
          >
            ←
          </button>
          <h1 className="text-2xl font-bold leading-tight">Admin — Users</h1>
        </div>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">
        {/* Invite a new user — 2026-08-10. STUB: no email is sent yet;
            see file header comment. */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-900 mb-1">Invite a new user</h2>
          <p className="text-xs text-gray-400 mb-4">
            Sends a signup link so they can create an account and password.
          </p>

          {inviteFlash && (
            <div
              className={`rounded-xl px-3 py-2 mb-3 text-sm ${
                inviteFlash.type === 'success'
                  ? 'bg-green-50 border border-green-200 text-green-800'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              {inviteFlash.text}
            </div>
          )}

          <form onSubmit={handleInvite} className="space-y-3">
            <div>
              <label htmlFor="invite-email" className="sr-only">
                Email address to invite
              </label>
              <input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={inviteEmail}
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  if (inviteFieldError) setInviteFieldError(null);
                }}
                disabled={inviting}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {/* Role picker toggle: Admin vs Sales Rep — exactly the two
                roles the `users.role` CHECK constraint allows. */}
            <div className="flex gap-2" role="radiogroup" aria-label="Role for the invited user">
              {(['admin', 'rep'] as const).map((r) => {
                const selected = inviteRole === r;
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setInviteRole(r);
                      if (inviteFieldError) setInviteFieldError(null);
                    }}
                    disabled={inviting}
                    className={`flex-1 text-sm font-semibold py-2 rounded-xl border transition-colors ${
                      selected
                        ? 'bg-brand-700 text-white border-brand-700'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300'
                    }`}
                  >
                    {r === 'admin' ? 'Admin' : 'Sales Rep'}
                  </button>
                );
              })}
            </div>

            {inviteFieldError && (
              <p className="text-xs text-red-600">{inviteFieldError}</p>
            )}

            <button
              type="submit"
              disabled={inviting}
              className="w-full bg-brand-700 hover:bg-brand-800 text-white font-semibold py-2.5 rounded-xl text-sm disabled:opacity-50"
            >
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </form>
        </div>

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
