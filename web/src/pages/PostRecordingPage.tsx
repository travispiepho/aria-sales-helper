import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import MeetingPage from './MeetingPage';

/** The single composition root for every completed or historical meeting. */
export default function PostRecordingPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/meetings" replace />;
  return <MeetingPage meetingId={id} pageMode="post" />;
}
