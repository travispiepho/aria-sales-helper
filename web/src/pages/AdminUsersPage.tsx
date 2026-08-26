import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import {
  listAdminUsers,
  deleteAdminUser,
  inviteUser,
  listInvites,
  regenerateInviteClaimCode,
  revokeInvite,
  AdminUser,
  Invite,
  InviteRole,
} from '../lib/api';
import { hasAdminAccess, isOwner, roleLabel } from '../lib/roles';
import AppHeader from '../components/AppHeader';

// AdminUsersPage — 2026-08-10, invite claim codes added 2026-08-18.
//
// Admin-only account list (soft-delete via DELETE /api/admin/users/:id)
// PLUS the "invite a new user" flow (POST /api/admin/invite), per Gabe's
// request: an admin-only email textbox + role picker (Admin/Sales Rep) +
// Invite button on this page.
//
// ⚠️ NOT EMAIL VERIFICATION / NO EMAIL IS EVER SENT. ⚠️
// POST /api/admin/invite persists a pending invite AND generates a
// one-time "claim code" (6 uppercase alphanumeric characters, ambiguous
// characters excluded). That plaintext code is returned ONCE in this
// screen and must be relayed to the rep out-of-band — text message or in
// person — by the admin. The rep then visits /signup and enters their
// email + that code + a new password to actually create their account
// (POST /api/signup/claim, public/unauthenticated). This proves the rep
// knows an email an admin typed AND holds a secret delivered out-of-band;
// it does NOT prove they control that mailbox. See server.js's route
// comments for the full model and why (no email-sending capability, no
// verified sending domain, no stable public URL yet).
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
  // Plaintext claim code from the most recent invite/regenerate call — held
  // ONLY in this component's state (never persisted, never refetchable).
  // Cleared as soon as the admin navigates away or creates/regenerates a
  // different one.
  const [lastClaimCode, setLastClaimCode] = useState<{ email: string; code: string } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // ── Pending invites list ───────────────────────────────────────────────
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);

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

  async function loadInvites() {
    setInvitesError(null);
    setInvitesLoading(true);
    try {
      const data = await listInvites();
      setInvites(data.invites);
    } catch (err: unknown) {
      setInvites(null);
      const msg = err instanceof Error ? err.message : 'Failed to load invites';
      setInvitesError(msg);
    } finally {
      setInvitesLoading(false);
    }
  }

  useEffect(() => {
    if (hasAdminAccess(user?.role)) {
      load();
      loadInvites();
    } else {
      setLoading(false);
      setInvitesLoading(false);
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
      // Deliberately "Invite recorded" + a displayed claim code, NOT "email
      // sent" — no email is ever sent by this system (see file header
      // comment). The admin must copy this code and text it to the rep (or
      // hand it over in person) themselves — it will not be shown again.
      setInviteFlash({
        type: 'success',
        text: `✅ Invite recorded for ${result.invite.email} (${result.invite.role === 'admin' ? 'Admin' : 'Sales Rep'}). Claim code shown below — copy it now.`,
      });
      setLastClaimCode({ email: result.invite.email, code: result.claimCode });
      setCopiedCode(false);
      setInviteEmail('');
      setInviteRole(null);
      await loadInvites();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Failed to record invite';
      setInviteFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setInviting(false);
    }
  }

  async function handleRegenerate(invite: Invite) {
    if (!confirm(
      `Regenerate the claim code for ${invite.email}?\n\n` +
      `The previous code (if not yet used) will stop working immediately.`
    )) {
      return;
    }
    setBusyInviteId(invite.id);
    try {
      const result = await regenerateInviteClaimCode(invite.id);
      setLastClaimCode({ email: result.invite.email, code: result.claimCode });
      setCopiedCode(false);
      setInviteFlash({
        type: 'success',
        text: `✅ New claim code generated for ${result.invite.email}. Copy it now — the old code no longer works.`,
      });
      await loadInvites();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Failed to regenerate claim code';
      setInviteFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setBusyInviteId(null);
    }
  }

  async function handleRevoke(invite: Invite) {
    if (!confirm(`Revoke the pending invite for ${invite.email}? Their claim code will stop working immediately.`)) {
      return;
    }
    setBusyInviteId(invite.id);
    try {
      await revokeInvite(invite.id);
      setInviteFlash({ type: 'success', text: `✅ Invite for ${invite.email} revoked.` });
      if (lastClaimCode?.email === invite.email) setLastClaimCode(null);
      await loadInvites();
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Failed to revoke invite';
      setInviteFlash({ type: 'error', text: `❌ ${text}` });
    } finally {
      setBusyInviteId(null);
    }
  }

  async function handleCopyCode() {
    if (!lastClaimCode) return;
    try {
      await navigator.clipboard.writeText(lastClaimCode.code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Clipboard API can fail (permissions/insecure context) — the code is
      // still visible on screen and selectable, so this is a soft failure.
    }
  }

  const pendingInvites = (invites || []).filter((i) => i.status === 'pending');

  // Non-admin fallback — friendly explanation instead of a blank page.
  // Server also returns 403 so this is a UX niceness, not a security gate.
  if (!loading && !hasAdminAccess(user?.role)) {
    return (
      <div className="min-h-screen bg-gray-200">
        <AppHeader title="Admin — Users" backTo="/" />
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
    <div className="min-h-screen bg-gray-200">
      <AppHeader title="Admin — Users" backTo="/" />

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">
        {/* Invite a new user — 2026-08-10, claim codes added 2026-08-18.
            NOT email verification: no email is sent, see file header
            comment. */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <h2 className="font-semibold text-gray-900 mb-1">Invite a new user</h2>
          <p className="text-xs text-gray-400 mb-4">
            Generates a one-time claim code. Nothing is emailed — you must text
            or hand the code to them yourself. They'll enter it at /signup
            along with their email and a new password.
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

          {/* One-time claim code display — shown only right after creating or
              regenerating an invite. This is the ONLY time it is ever
              visible; there is no way to retrieve it again afterward
              (regenerate mints a new one and invalidates this one). */}
          {lastClaimCode && (
            <div className="rounded-xl px-4 py-3 mb-3 bg-amber-50 border border-amber-200">
              <p className="text-xs font-semibold text-amber-900 mb-1">
                Claim code for {lastClaimCode.email} — shown once
              </p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-2xl font-bold tracking-widest text-amber-900">
                  {lastClaimCode.code}
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-amber-200 hover:bg-amber-300 text-amber-900"
                >
                  {copiedCode ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-amber-800 mt-2">
                Deliver this to them by text message or in person now. It will
                not be shown again — use "Regenerate" below if it's lost.
              </p>
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
                        ? 'bg-brand-100 text-brand-900 border-brand-500 ring-1 ring-brand-500'
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

        {/* Pending invites — 2026-08-18. Shows expiry and lets the admin
            regenerate a lost/expired claim code or revoke the invite
            outright. Accepted/revoked invites aren't listed here — this is
            specifically the "still actionable" set. */}
        {invitesLoading && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-center text-gray-400 text-sm">
            Loading invites…
          </div>
        )}
        {invitesError && !invitesLoading && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-sm text-red-600">❌ Failed to load invites: {invitesError}</p>
          </div>
        )}
        {!invitesLoading && !invitesError && pendingInvites.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-gray-900">Pending invites</h2>
              <span className="text-xs text-gray-400">{pendingInvites.length}</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {pendingInvites.map((invite) => {
                const isBusy = busyInviteId === invite.id;
                const expired = invite.expires_at ? new Date(invite.expires_at) < new Date() : false;
                return (
                  <li key={invite.id} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{invite.email}</p>
                        <p className="text-xs text-gray-500">
                          {invite.role === 'admin' ? 'Admin' : 'Sales Rep'} ·{' '}
                          {expired ? (
                            <span className="text-red-600 font-medium">Expired</span>
                          ) : invite.expires_at ? (
                            `Expires ${new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                          ) : (
                            'No expiry set'
                          )}
                        </p>
                      </div>
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleRegenerate(invite)}
                          disabled={isBusy}
                          className="text-xs font-semibold px-2.5 py-1.5 rounded-lg text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                        >
                          {isBusy ? '…' : 'Regenerate'}
                        </button>
                        <button
                          onClick={() => handleRevoke(invite)}
                          disabled={isBusy}
                          className="text-xs font-semibold px-2.5 py-1.5 rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          {isBusy ? '…' : 'Revoke'}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

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
                    // Owner-only admin deletion (2026-08-10). Only the owner
                    // may remove an admin-level account (admin OR owner
                    // target); reps stay deletable by any admin. This mirrors
                    // the server's guard in DELETE /api/admin/users/:id —
                    // the SERVER is the real security boundary, this just
                    // avoids offering a button that would always 403.
                    const blockedByOwnerRule =
                      hasAdminAccess(u.role) && !isOwner(user?.role);
                    const disabled = isSelf || isBusy || blockedByOwnerRule;
                    const disabledReason = isSelf
                      ? "You can't delete your own account"
                      : blockedByOwnerRule
                        ? 'Only the owner can remove admin accounts'
                        : 'Delete this account';
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
                          {/* Owner renders distinctly (amber) from admin
                              (brand) and rep (gray) so the elevated role is
                              visually obvious at a glance. */}
                          <span
                            className={`inline-block mt-0.5 text-[10px] font-medium px-2 py-0.5 rounded-full ${
                              u.role === 'owner'
                                ? 'bg-amber-100 text-amber-800'
                                : u.role === 'admin'
                                  ? 'bg-brand-100 text-brand-700'
                                  : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {roleLabel(u.role)}
                          </span>
                        </div>
                        {/* Disabled (not hidden) when the owner rule blocks
                            it: a greyed button + tooltip explains WHY the
                            action is unavailable, whereas hiding it would
                            look like a bug to an admin who expects it. */}
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={disabled}
                          title={disabledReason}
                          className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                            isSelf || blockedByOwnerRule
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
