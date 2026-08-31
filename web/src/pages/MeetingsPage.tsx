import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppPageLayout from '../components/AppPageLayout';
import { postRecordingPath } from '../lib/meetingRoutes';
import {
  deleteMeeting,
  listMeetings,
  Meeting,
} from '../lib/api';

const PAGE_SIZE = 20;

function formatDate(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(meeting: Meeting) {
  if (!meeting.ended_at) return null;
  const seconds = Math.max(0, Math.round(
    (new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime()) / 1000,
  ));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function statusBadge(status: Meeting['status']) {
  const map: Record<Meeting['status'], string> = {
    active: 'bg-green-100 text-green-800',
    completed: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-red-100 text-red-700',
    interrupted: 'bg-amber-100 text-amber-800',
  };
  return map[status] ?? 'bg-gray-100 text-gray-600';
}

export default function MeetingsPage() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pageOffset, setPageOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function loadMeetings() {
    setLoadError(false);
    try {
      const page = await listMeetings(0, PAGE_SIZE);
      setMeetings(page.meetings);
      setHasMore(page.hasMore);
      setPageOffset(page.meetings.length);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMeetings();
  }, []);

  async function loadMoreMeetings() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await listMeetings(pageOffset, PAGE_SIZE);
      setMeetings(previous => {
        const seen = new Set(previous.map(meeting => meeting.id));
        return [...previous, ...page.meetings.filter(meeting => !seen.has(meeting.id))];
      });
      setHasMore(page.hasMore);
      setPageOffset(previous => previous + page.meetings.length);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleDelete(event: React.MouseEvent, id: string) {
    event.stopPropagation();
    if (!confirm('Delete this meeting and its transcript? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await deleteMeeting(id);
      setMeetings(previous => previous.filter(meeting => meeting.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete meeting');
    } finally {
      setDeletingId(null);
    }
  }

  const today = new Date().toDateString();
  const recordedMeetings = meetings.filter(meeting => !meeting.scheduled_for || !!meeting.scheduled_started_at);
  const todayMeetings = recordedMeetings.filter(meeting => new Date(meeting.started_at).toDateString() === today);
  const previousMeetings = recordedMeetings.filter(meeting => new Date(meeting.started_at).toDateString() !== today);

  function meetingList(items: Meeting[]) {
    return (
      <div className="space-y-3">
        {items.map(meeting => {
          const duration = formatDuration(meeting);
          return (
            <article key={meeting.id} className="relative group">
              <button
                onClick={() => navigate(postRecordingPath(meeting.id))}
                className="w-full min-h-11 bg-white rounded-2xl shadow-sm border border-gray-100 p-4 text-left hover:border-brand-300 transition-colors"
                aria-label={`Open meeting ${meeting.title || meeting.customer_name || 'No customer linked'}`}
              >
                <div className="flex items-center justify-between pr-14 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">
                      {meeting.title || meeting.customer_name || 'No customer linked'}
                    </p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {formatDate(meeting.started_at)}
                      {duration && <> · {duration}</>}
                    </p>
                    {meeting.title && meeting.customer_name && meeting.title !== meeting.customer_name && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">Customer: {meeting.customer_name}</p>
                    )}
                    {meeting.rep_name && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">Rep: {meeting.rep_name}</p>
                    )}
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize flex-shrink-0 ${statusBadge(meeting.status)}`}>
                    {meeting.status}
                  </span>
                </div>
              </button>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={event => handleDelete(event, meeting.id)}
                  disabled={deletingId === meeting.id}
                  className="w-11 h-11 text-gray-400 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50 disabled:opacity-40"
                  aria-label={`Delete ${meeting.title || meeting.customer_name || 'meeting'}`}
                  title="Delete meeting"
                >
                  {deletingId === meeting.id ? '…' : '🗑'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <AppPageLayout title="Meetings" subtitle="Your meeting history">
      {loading ? (
          <div role="status" aria-label="Loading meetings" className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-4 border-brand-600 border-t-transparent rounded-full" />
          </div>
        ) : loadError ? (
          <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6 text-center">
            <div className="text-3xl mb-2" aria-hidden="true">⚠️</div>
            <p className="text-gray-700 text-sm font-medium mb-1">Couldn't load your meetings</p>
            <p className="text-gray-500 text-xs mb-4">Check your connection and try again.</p>
            <button
              onClick={() => { setLoading(true); loadMeetings(); }}
              className="min-h-11 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-colors"
            >
              Retry
            </button>
          </div>
        ) : meetings.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="text-3xl mb-2" aria-hidden="true">📋</div>
            <p className="text-gray-700 text-sm font-medium">No meetings yet</p>
            <p className="text-gray-500 text-xs mt-1">Meetings you record will appear here.</p>
          </div>
        ) : (
          <>
            <section aria-labelledby="today-meetings-heading">
              <h2 id="today-meetings-heading" className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Today's Meetings
              </h2>
              {todayMeetings.length ? meetingList(todayMeetings) : (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 text-center">
                  <p className="text-gray-500 text-sm">No meetings yet today</p>
                </div>
              )}
            </section>

            {previousMeetings.length > 0 && (
              <section aria-labelledby="previous-meetings-heading" className="mt-6">
                <h2 id="previous-meetings-heading" className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Previous Meetings
                </h2>
                {meetingList(previousMeetings)}
              </section>
            )}

            {hasMore && (
              <div className="mt-4 text-center">
                {loadMoreError && (
                  <p role="alert" className="text-sm text-red-700 mb-2">Couldn't load more meetings. Try again.</p>
                )}
                <button
                  onClick={loadMoreMeetings}
                  disabled={loadingMore}
                  className="w-full min-h-11 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60 transition-colors"
                >
                  {loadingMore ? 'Loading…' : loadMoreError ? 'Retry load more' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
    </AppPageLayout>
  );
}
