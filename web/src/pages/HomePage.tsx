import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listMeetings, createMeeting, deleteMeeting, getMeeting, getMeetingSegments, updateMeeting, Meeting } from '../lib/api';
import CustomerIntakeModal from '../components/CustomerIntakeModal';

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();

  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status: Meeting['status']) {
  const map: Record<Meeting['status'], string> = {
    active: 'bg-green-100 text-green-800',
    completed: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-red-100 text-red-700',
    // 'interrupted' (2026-08-05, server-side auto-finalize on abandoned WS
    // connections) was already a valid runtime status value before this
    // pass — just missing from the Meeting['status'] TS union until this
    // task's api.ts fix, which is what surfaced this as a type error here.
    // Amber, not red: distinct from a rep's intentional 'cancelled', not
    // as neutral as a clean 'completed'.
    interrupted: 'bg-amber-100 text-amber-800',
  };
  return map[status] ?? 'bg-gray-100 text-gray-600';
}

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showIntake, setShowIntake] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // 2026-08-07: pagination state for the "Recent" list — backend now
  // returns limit+offset pages (see api.ts's listMeetings/MeetingsPage)
  // instead of one unbounded/recent-only array. A "Load more" button
  // (rather than infinite-scroll) was chosen deliberately: this list
  // renders inside a page that already scrolls with the rest of the
  // Home screen (Start Meeting CTA + Today's list above it), so an
  // IntersectionObserver-driven auto-load risks firing while the user is
  // simply scrolling past unrelated content above, or double-firing on
  // fast scroll/loading-state races — a plain button is a much smaller,
  // easier-to-get-right surface for the time available, with identical
  // end-user capability (reach older meetings) and no risk of an
  // unexpected/uncontrolled fetch loop.
  const PAGE_SIZE = 20;
  const [pageOffset, setPageOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // (2026-08-10) GET /api/meetings failure state — previously
  // loadMeetings() swallowed any fetch error entirely (bare `catch {}`,
  // see below), leaving `meetings` at its initial `[]` and rendering the
  // exact same "No meetings yet today" empty-state copy as a genuinely
  // empty account. During the 8/9 outage (backend 502s) this meant the
  // homescreen looked identical to "you have no meetings" when the real
  // cause was a failed fetch — no way for a rep to tell the difference or
  // retry without a full page reload. `loadError` now distinguishes the
  // two cases; see the render branch below for the retry-button UI. This
  // does NOT touch loadMoreMeetings()'s own separate silent-catch ("Load
  // more" already has a natural, always-visible retry affordance — the
  // button itself just stays clickable, per the task's happy-path-only
  // scope for this fix; the FIRST/initial fetch silently failing into a
  // blank homescreen was the actual incident-relevant gap).
  const [loadError, setLoadError] = useState(false);

  async function handleDownload(e: React.MouseEvent, m: Meeting) {
    e.stopPropagation();
    setDownloadingId(m.id);
    try {
      const [full, { segments }] = await Promise.all([
        getMeeting(m.id),
        getMeetingSegments(m.id),
      ]);
      const labels: Record<string, string> = full.speaker_labels || {};
      const getLabel = (raw: string) => labels[raw] || raw;
      const displayTitle = full.title || full.customer_name || 'Meeting';
      const meetingDate = new Date(full.started_at).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      const meetingTime = new Date(full.started_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
      });
      const lines: string[] = [];
      lines.push('ARIA MEETING TRANSCRIPT');
      lines.push('='.repeat(60));
      lines.push(`Title:    ${displayTitle}`);
      lines.push(`Customer: ${full.customer_name || '—'}`);
      lines.push(`Date:     ${meetingDate} at ${meetingTime}`);
      lines.push('');
      if (full.summary) {
        lines.push('SUMMARY');
        lines.push('─'.repeat(60));
        lines.push(full.summary);
        lines.push('');
      }
      lines.push('TRANSCRIPT');
      lines.push('─'.repeat(60));
      if (segments.length === 0) {
        lines.push('(no transcript recorded)');
      } else {
        let lastLabel = '';
        segments.forEach((seg: { speaker: string; text: string }) => {
          const label = getLabel(seg.speaker);
          if (label !== lastLabel) {
            if (lastLabel) lines.push('');
            lines.push(`[${label}]`);
            lastLabel = label;
          }
          lines.push(seg.text);
        });
      }
      lines.push('');
      lines.push('='.repeat(60));
      lines.push('Generated by ARIA — CertaPro Grand Haven');
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${displayTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-transcript.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to download transcript');
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this meeting and its transcript? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await deleteMeeting(id);
      setMeetings(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete meeting');
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    loadMeetings();
  }, []);

  async function loadMeetings() {
    setLoadError(false);
    try {
      const page = await listMeetings(0, PAGE_SIZE);
      setMeetings(page.meetings);
      setHasMore(page.hasMore);
      setPageOffset(page.meetings.length);
    } catch {
      // 2026-08-10: was a bare silent catch — now surfaces a visible
      // error state with a retry action (see loadError render branch)
      // instead of rendering an indistinguishable empty list.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreMeetings() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await listMeetings(pageOffset, PAGE_SIZE);
      // De-dupe defensively in case a meeting shifted pages between
      // requests (e.g. a brand-new meeting was created in between).
      setMeetings(prev => {
        const seen = new Set(prev.map(m => m.id));
        return [...prev, ...page.meetings.filter(m => !seen.has(m.id))];
      });
      setHasMore(page.hasMore);
      setPageOffset(prev => prev + page.meetings.length);
    } catch {
      // silent — leave hasMore as-is so the user can retry the button
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleStartMeeting(customerId?: string, title?: string) {
    setStarting(true);
    try {
      const meeting = await createMeeting(customerId);
      if (title) await updateMeeting(meeting.id, { title }).catch(() => {});
      navigate(`/meetings/${meeting.id}`);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to start meeting');
    } finally {
      setStarting(false);
    }
  }

  // Today's meetings
  const todayStr = new Date().toDateString();
  const todayMeetings = meetings.filter(
    m => new Date(m.started_at).toDateString() === todayStr
  );

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-brand-700 text-white px-5 pt-6 pb-8 safe-top">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold leading-tight">ARIA</h1>
            <p className="text-brand-100 text-base leading-relaxed">Hey {user?.name?.split(' ')[0]} 👋</p>
          </div>
          <button
            onClick={() => navigate('/profile')}
            className="w-11 h-11 rounded-full bg-brand-600 border-2 border-brand-400 hover:bg-brand-500 flex items-center justify-center text-white font-bold text-base transition-colors flex-shrink-0"
            aria-label="Profile"
          >
            {user?.name?.charAt(0)?.toUpperCase() || '?'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 -mt-2 pb-24">
        {/* Start Meeting CTA */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-6">
          <h2 className="font-semibold text-gray-900 mb-1">Ready to meet?</h2>
          <p className="text-sm text-gray-500 mb-4">
            Start a meeting to capture the conversation and intake details.
          </p>
          <button
            onClick={() => setShowIntake(true)}
            disabled={starting}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors"
          >
            {starting ? 'Starting…' : '▶ Start Meeting'}
          </button>
        </div>

        {/* Today's Meetings */}
        <div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Today's Meetings
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
            </div>
          ) : loadError ? (
            // 2026-08-10: visible error + retry, replacing what used to
            // silently fall through to the "No meetings yet today" empty
            // state below on any fetch failure (e.g. the 8/9 outage's
            // GET /api/meetings 502s) — a rep opening the app during an
            // outage now sees this instead of a blank/empty homescreen.
            <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
              <div className="text-3xl mb-2">⚠️</div>
              <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load your meetings</p>
              <p className="text-gray-500 text-xs mb-4">Check your connection and try again.</p>
              <button
                onClick={() => { setLoading(true); loadMeetings(); }}
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
              >
                Retry
              </button>
            </div>
          ) : todayMeetings.length === 0 ? (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
              <div className="text-3xl mb-2">📋</div>
              <p className="text-gray-500 text-sm">No meetings yet today</p>
            </div>
          ) : (
            <div className="space-y-3">
              {todayMeetings.map(m => (
                <div key={m.id} className="relative group">
                  <button
                    onClick={() => navigate(`/meetings/${m.id}`)}
                    className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-left hover:border-brand-300 transition-colors"
                  >
                    <div className="flex items-center justify-between pr-16">
                      <div>
                        <p className="font-medium text-gray-900">
                          {m.title || m.customer_name || 'No customer linked'}
                        </p>
                        <p className="text-sm text-gray-500 mt-0.5">
                          {formatDate(m.started_at)}
                        </p>
                      </div>
                      <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${statusBadge(m.status)}`}>
                        {m.status}
                      </span>
                    </div>
                  </button>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <button
                      onClick={(e) => handleDownload(e, m)}
                      disabled={downloadingId === m.id}
                      className="text-gray-300 hover:text-blue-500 transition-colors p-1 rounded-lg hover:bg-blue-50 disabled:opacity-40"
                      title="Download transcript"
                    >
                      {downloadingId === m.id ? '…' : '⬇️'}
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, m.id)}
                      disabled={deletingId === m.id}
                      className="text-gray-300 hover:text-red-500 transition-colors p-1 rounded-lg hover:bg-red-50 disabled:opacity-40"
                      title="Delete meeting"
                    >
                      {deletingId === m.id ? '…' : '🗑'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent (non-today) */}
        {meetings.filter(m => new Date(m.started_at).toDateString() !== todayStr).length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Recent
            </h2>
            <div className="space-y-3">
              {meetings
                .filter(m => new Date(m.started_at).toDateString() !== todayStr)
                .map(m => (
                  <div key={m.id} className="relative group">
                    <button
                      onClick={() => navigate(`/meetings/${m.id}`)}
                      className="w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-left hover:border-brand-300 transition-colors"
                    >
                      <div className="flex items-center justify-between pr-16">
                        <div>
                          <p className="font-medium text-gray-900">
                            {m.title || m.customer_name || 'No customer linked'}
                          </p>
                          <p className="text-sm text-gray-500 mt-0.5">
                            {formatDate(m.started_at)}
                          </p>
                        </div>
                        <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${statusBadge(m.status)}`}>
                          {m.status}
                        </span>
                      </div>
                    </button>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                      <button
                        onClick={(e) => handleDownload(e, m)}
                        disabled={downloadingId === m.id}
                        className="text-gray-300 hover:text-blue-500 transition-colors p-1 rounded-lg hover:bg-blue-50 disabled:opacity-40"
                        title="Download transcript"
                      >
                        {downloadingId === m.id ? '…' : '⬇️'}
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, m.id)}
                        disabled={deletingId === m.id}
                        className="text-gray-300 hover:text-red-500 transition-colors p-1 rounded-lg hover:bg-red-50 disabled:opacity-40"
                        title="Delete meeting"
                      >
                        {deletingId === m.id ? '…' : '🗑'}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
            {hasMore && (
              <button
                onClick={loadMoreMeetings}
                disabled={loadingMore}
                className="w-full mt-4 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Customer Intake Modal */}
      {showIntake && (
        <CustomerIntakeModal
          onClose={() => setShowIntake(false)}
          onCreated={(customerId, title) => {
            setShowIntake(false);
            handleStartMeeting(customerId, title);
          }}
        />
      )}
    </div>
  );
}
