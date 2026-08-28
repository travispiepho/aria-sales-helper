import React, { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { getMeeting, type Meeting } from '../lib/api';
import { canonicalMeetingPath } from '../lib/meetingRoutes';

/** Resolves the old combined meeting URL from authoritative server state. */
export default function MeetingRouteResolver() {
  const { id } = useParams<{ id: string }>();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    getMeeting(id)
      .then(value => { if (!cancelled) setMeeting(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [id]);

  if (failed) return <Navigate to="/meetings" replace />;
  if (meeting) return <Navigate to={canonicalMeetingPath(meeting)} replace />;
  return (
    <div className="min-h-screen bg-gray-200 flex items-center justify-center" role="status" aria-label="Loading meeting">
      <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
    </div>
  );
}
