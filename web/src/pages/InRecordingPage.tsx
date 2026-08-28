import React, { useEffect, useState } from 'react';
import { matchPath, Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader';
import { getMeeting, type Meeting } from '../lib/api';
import { postRecordingPath } from '../lib/meetingRoutes';
import MeetingPage from './MeetingPage';
import UploadedRecordingPage from './UploadedRecordingPage';

function UploadedRecordingRecovery({ meetingId }: { meetingId: string }) {
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconcile = async () => {
      try {
        const latest = await getMeeting(meetingId);
        if (cancelled) return;
        setMeeting(latest);
        setError('');
        if (latest.status !== 'active') {
          navigate(postRecordingPath(meetingId), { replace: true });
          return;
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not check this analysis.');
      }
      if (!cancelled) timer = setTimeout(reconcile, 2_000);
    };
    void reconcile();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [meetingId, navigate]);

  return (
    <div className="min-h-screen bg-gray-200 flex flex-col">
      <AppHeader title="Recording analysis" subtitle="Recovering authoritative meeting state" backTo="/meetings" />
      <main className="flex-1 px-4 py-4 max-w-3xl w-full mx-auto">
        <section className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5" aria-live="polite">
          <h1 className="font-semibold text-gray-900">Local playback is no longer connected</h1>
          <p className="text-sm text-gray-600 mt-2">
            The source recording stayed on the previous page and cannot be resumed after a refresh. ARIA is checking the saved meeting state before showing post-recording results.
          </p>
          {meeting?.status === 'active' && <p className="text-sm font-medium text-amber-700 mt-3">Analysis is still finalizing or being marked interrupted…</p>}
          {error && <p role="alert" className="text-sm text-red-700 mt-3">{error}</p>}
        </section>
      </main>
    </div>
  );
}

/** The single composition root for every active meeting type. */
export default function InRecordingPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const match = matchPath('/meetings/:id/active', location.pathname);
  const meetingId = match?.params.id;
  const isUploadEntry = location.pathname === '/recordings/analyze';
  const [localUploadMeetingId, setLocalUploadMeetingId] = useState<string | null>(null);
  const [remoteMeeting, setRemoteMeeting] = useState<Meeting | null>(null);

  const ownsLocalUpload = isUploadEntry || (!!meetingId && localUploadMeetingId === meetingId);

  useEffect(() => {
    if (!meetingId || ownsLocalUpload) {
      setRemoteMeeting(null);
      return;
    }
    let cancelled = false;
    getMeeting(meetingId)
      .then(value => {
        if (cancelled) return;
        if (value.status !== 'active') {
          navigate(postRecordingPath(value.id), { replace: true });
          return;
        }
        setRemoteMeeting(value);
      })
      .catch(() => {
        // MeetingPage owns the normal authenticated error path. A transient
        // lookup here must not falsely move an active meeting to post state.
        if (!cancelled) setRemoteMeeting({ id: meetingId } as Meeting);
      });
    return () => { cancelled = true; };
  }, [meetingId, navigate, ownsLocalUpload]);

  let content: React.ReactNode;
  if (ownsLocalUpload) {
    content = <UploadedRecordingPage onMeetingStarted={setLocalUploadMeetingId} />;
  } else if (!meetingId || !remoteMeeting) {
    content = (
      <div className="min-h-screen bg-gray-200 flex items-center justify-center" role="status" aria-label="Loading active meeting">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  } else if (remoteMeeting.channel === 'uploaded_recording') {
    content = <UploadedRecordingRecovery meetingId={meetingId} />;
  } else {
    content = <MeetingPage meetingId={meetingId} pageMode="active" />;
  }

  return <>{content}<Outlet /></>;
}
