import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { claimInvite } from '../lib/api';

// SignupClaimPage — 2026-08-18.
//
// ⚠️ NOT EMAIL VERIFICATION. This page implements "invite claim": a rep
// who was given an email + one-time claim code by an admin (relayed by
// text message or in person — nothing is emailed by this system) enters
// that email, the code, and a new password to create their account. It
// proves the rep knows an email an admin typed AND holds a secret
// delivered out-of-band. It does NOT prove they control that mailbox.
//
// Public route (no auth) — linked from LoginPage. On success, routes to
// /login with the new email prefilled rather than auto-logging the rep
// in: this keeps the "your account now exists, sign in like normal" model
// simple and consistent with there being no session-establishing side
// effect baked into claim, matching this codebase's existing pattern of
// login being its own explicit step (see LoginPage.tsx).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupClaimPage() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ email: string } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const trimmedEmail = email.trim();
    const trimmedCode = claimCode.trim();

    if (!trimmedEmail) {
      setFieldError('Enter the email address the invite was sent to.');
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setFieldError('Enter a valid email address.');
      return;
    }
    if (!trimmedCode) {
      setFieldError('Enter the claim code your admin gave you.');
      return;
    }
    if (password.length < 8) {
      setFieldError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setFieldError('Passwords do not match.');
      return;
    }
    setFieldError(null);

    setSubmitting(true);
    try {
      await claimInvite(trimmedEmail, trimmedCode, password);
      setSuccess({ email: trimmedEmail });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      setServerError(text);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="min-h-screen bg-brand-700 flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="bg-white rounded-2xl shadow-xl p-6 text-center">
            <div className="text-4xl mb-3">✅</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Account created</h1>
            <p className="text-sm text-gray-600 mb-6">
              Your account for <span className="font-medium">{success.email}</span> is
              ready. Sign in with your new password to get started.
            </p>
            <button
              onClick={() => navigate('/login', { replace: true })}
              className="w-full bg-brand-700 hover:bg-brand-800 text-white font-semibold py-3 px-4 rounded-xl transition-colors"
            >
              Go to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-700 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white rounded-2xl shadow-lg mb-4">
            <span className="text-3xl font-black text-brand-700">S</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Claim your ARIA account</h1>
          <p className="text-brand-100 text-sm mt-1">
            Enter the email + claim code your admin gave you
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {serverError && (
              <div className="bg-red-50 text-red-700 rounded-lg px-4 py-3 text-sm">
                {serverError}
              </div>
            )}
            {fieldError && (
              <div className="bg-red-50 text-red-700 rounded-lg px-4 py-3 text-sm">
                {fieldError}
              </div>
            )}

            <div>
              <label htmlFor="signup-email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                id="signup-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                disabled={submitting}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                placeholder="you@certaprograndhaven.com"
              />
            </div>

            <div>
              <label htmlFor="signup-code" className="block text-sm font-medium text-gray-700 mb-1">
                Claim code
              </label>
              <input
                id="signup-code"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                inputMode="text"
                maxLength={6}
                value={claimCode}
                onChange={(e) => {
                  setClaimCode(e.target.value.toUpperCase());
                  if (fieldError) setFieldError(null);
                }}
                disabled={submitting}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent tracking-widest font-mono uppercase"
                placeholder="ABC123"
              />
              <p className="text-xs text-gray-400 mt-1">
                The 6-character code texted or given to you by your admin.
              </p>
            </div>

            <div>
              <label htmlFor="signup-password" className="block text-sm font-medium text-gray-700 mb-1">
                New password
              </label>
              <input
                id="signup-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                disabled={submitting}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                placeholder="At least 8 characters"
              />
            </div>

            <div>
              <label htmlFor="signup-confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm password
              </label>
              <input
                id="signup-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                disabled={submitting}
                className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                placeholder="Re-enter password"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-60 text-white font-semibold py-3 px-4 rounded-xl transition-colors"
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>

            <p className="text-center text-sm text-gray-500">
              Already have an account?{' '}
              <Link to="/login" className="text-brand-700 font-medium">
                Sign in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
