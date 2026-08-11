import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { apiFetch, changePassword } from '../lib/api';
import { extractVoiceFeatures, VoiceFeatures } from '../lib/voiceFeatures';
import { roleLabel } from '../lib/roles';

const ENROLL_DURATION_MS = 30000; // 30 seconds
const SAMPLE_RATE = 16000;

interface VoicePrintStatus {
  enrolled: boolean;
  duration_ms?: number;
  created_at?: string;
}

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [vpStatus, setVpStatus] = useState<VoicePrintStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [vpMsg, setVpMsg] = useState('');

  // Change Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    apiFetch('/api/profile/voice-print')
      .then(r => r.json())
      .then((data: VoicePrintStatus) => setVpStatus(data))
      .catch(() => setVpStatus({ enrolled: false }));
    return () => stopRecording();
  }, []);

  async function startRecording() {
    setVpMsg('');
    samplesRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      // Use AnalyserNode at 16kHz to match meeting audio sample rate for consistent features
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const bufferLength = analyser.fftSize;
      const buffer = new Float32Array(bufferLength);

      // Poll the analyser at ~60fps and collect time-domain samples
      let rafId: number;
      const collect = () => {
        analyser.getFloatTimeDomainData(buffer);
        samplesRef.current.push(new Float32Array(buffer));
        rafId = requestAnimationFrame(collect);
      };
      collect();
      (analyser as unknown as { _rafId: number })._rafId = rafId!;
      (analyser as unknown as { _stopCollect: () => void })._stopCollect = () => cancelAnimationFrame(rafId);
      workletRef.current = analyser as unknown as AudioWorkletNode;

      startTimeRef.current = Date.now();
      setElapsed(0);
      setRecording(true);

      timerRef.current = setInterval(() => {
        const el = Date.now() - startTimeRef.current;
        setElapsed(el);
        if (el >= ENROLL_DURATION_MS) {
          stopAndSave();
        }
      }, 200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setVpMsg(`❌ Could not access microphone: ${msg}`);
    }
  }

  function stopRecording() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    // Stop the analyser RAF loop
    const node = workletRef.current as unknown as { _stopCollect?: () => void };
    if (node?._stopCollect) node._stopCollect();
    (workletRef.current as unknown as AudioNode | null)?.disconnect?.();
    audioCtxRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach(t => t.stop());
    workletRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    setRecording(false);
    setElapsed(0);
  }

  async function stopAndSave() {
    const durationMs = Date.now() - startTimeRef.current;
    stopRecording();

    if (samplesRef.current.length === 0) {
      setVpMsg('❌ No audio captured. Try again.');
      return;
    }

    setSaving(true);
    setVpMsg('Analyzing voice…');

    // Flatten all PCM chunks
    const totalLen = samplesRef.current.reduce((s, c) => s + c.length, 0);
    const all = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of samplesRef.current) { all.set(chunk, offset); offset += chunk.length; }

    // Extract features
    const features: VoiceFeatures = extractVoiceFeatures(all);

    if (features.frame_count < 10) {
      setVpMsg('❌ Not enough speech detected. Please speak clearly and try again.');
      setSaving(false);
      return;
    }

    try {
      await apiFetch('/api/profile/voice-print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features, duration_ms: durationMs }),
      });
      const updated: VoicePrintStatus = await apiFetch('/api/profile/voice-print').then(r => r.json());
      setVpStatus(updated);
      setVpMsg('✅ Voice enrolled successfully!');
    } catch {
      setVpMsg('❌ Failed to save voice print. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Remove your voice enrollment? ARIA will no longer auto-identify you during meetings.')) return;
    await apiFetch('/api/profile/voice-print', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    setVpStatus({ enrolled: false });
    setVpMsg('');
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPwMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }
    if (newPassword.length < 8) {
      setPwMsg({ type: 'error', text: 'New password must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'New password and confirmation do not match.' });
      return;
    }

    setPwSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPwMsg({ type: 'success', text: '✅ Password changed successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to change password.';
      setPwMsg({ type: 'error', text: msg });
    } finally {
      setPwSaving(false);
    }
  }

  const progressPct = Math.min((elapsed / ENROLL_DURATION_MS) * 100, 100);
  const secondsLeft = Math.max(0, Math.ceil((ENROLL_DURATION_MS - elapsed) / 1000));

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/')}
            className="text-brand-100 hover:text-white text-2xl leading-none p-1"
          >
            ←
          </button>
          <h1 className="text-2xl font-bold leading-tight">Profile</h1>
        </div>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto space-y-4">

        {/* Avatar + name */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-brand-600 flex items-center justify-center text-white text-2xl font-bold flex-shrink-0">
            {user?.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div>
            <p className="text-lg font-semibold text-gray-900">{user?.name || '—'}</p>
            <p className="text-sm text-gray-500">{user?.email || '—'}</p>
            {/* Role badge — uses the shared roleLabel() helper so the
                'owner' role (added 2026-08-10, higher than admin) renders
                as "Owner" with its own amber styling rather than falling
                through to the generic admin badge. See lib/roles.ts. */}
            <span
              className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                user?.role === 'owner'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-brand-100 text-brand-700'
              }`}
            >
              {roleLabel(user?.role)}
            </span>
          </div>
        </div>

        {/* Voice Enrollment */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🎙️</span>
            <h2 className="font-semibold text-gray-900">Voice Recognition</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Record a 30-second voice sample so ARIA can automatically identify you during meetings — no more manual speaker labeling.
          </p>

          {/* Enrolled status */}
          {vpStatus?.enrolled && !recording && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-green-800">✅ Voice enrolled</p>
                {vpStatus.created_at && (
                  <p className="text-xs text-green-600 mt-0.5">
                    Enrolled {new Date(vpStatus.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
              </div>
              <button
                onClick={handleDelete}
                className="text-xs text-red-500 hover:text-red-700 font-medium"
              >
                Remove
              </button>
            </div>
          )}

          {/* Recording UI */}
          {recording ? (
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-red-800 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                    Recording…
                  </span>
                  <span className="text-sm font-mono text-red-700">{secondsLeft}s left</span>
                </div>
                <div className="w-full h-2 bg-red-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-200"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-red-600 mt-2">
                  Speak naturally — describe a room, read anything aloud, or just talk.
                </p>
              </div>
              <button
                onClick={stopAndSave}
                disabled={saving}
                className="w-full bg-gray-800 hover:bg-gray-900 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
              >
                {saving ? 'Saving…' : 'Stop & Save Early'}
              </button>
            </div>
          ) : (
            <button
              onClick={startRecording}
              disabled={saving}
              className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
            >
              🎙️ {vpStatus?.enrolled ? 'Re-record Voice Sample' : 'Record Voice Sample (30s)'}
            </button>
          )}

          {vpMsg && (
            <p className={`text-sm mt-3 text-center ${vpMsg.startsWith('✅') ? 'text-green-700' : vpMsg.startsWith('❌') ? 'text-red-600' : 'text-gray-500'}`}>
              {vpMsg}
            </p>
          )}
        </div>

        {/* Change Password */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🔒</span>
            <h2 className="font-semibold text-gray-900">Change Password</h2>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Update your account password. You'll need to enter your current password to confirm.
          </p>

          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Current Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">New Password</label>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Confirm New Password</label>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {pwMsg && (
              <p className={`text-sm ${pwMsg.type === 'success' ? 'text-green-700' : 'text-red-600'}`}>
                {pwMsg.text}
              </p>
            )}

            <button
              type="submit"
              disabled={pwSaving}
              className="w-full bg-brand-700 hover:bg-brand-800 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
            >
              {pwSaving ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </div>

        {/* App info */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-5 py-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">App</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Product</span>
              <span className="text-sm font-medium text-gray-900">ARIA Sales Helper</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Company</span>
              <span className="text-sm font-medium text-gray-900">CertaPro Grand Haven</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Version</span>
              <span className="text-sm font-medium text-gray-500">Phase 3</span>
            </div>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={logout}
          className="w-full bg-white border border-red-200 hover:bg-red-50 text-red-600 font-semibold py-4 rounded-2xl transition-colors text-sm"
        >
          Sign Out
        </button>

      </div>
    </div>
  );
}
