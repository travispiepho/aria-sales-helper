import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AppHeader from '../components/AppHeader';
import ScheduledMeetingForm from '../components/ScheduledMeetingForm';
import { getMeeting, Meeting, updateScheduledMeeting } from '../lib/api';

export default function EditScheduledMeetingPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    getMeeting(id).then(setMeeting).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load meeting.'));
  }, [id]);
  return (
    <div className="min-h-screen bg-gray-200">
      <AppHeader title="Edit Scheduled Meeting" backTo="/" backLabel="Back to Home" />
      <main className="px-4 -mt-2 pb-24 max-w-lg mx-auto">
        {error ? <div role="alert" className="bg-white rounded-2xl p-5 text-red-700">{error}</div> : !meeting ?
          <div role="status" aria-label="Loading scheduled meeting" className="py-12 text-center">Loading…</div> :
          <ScheduledMeetingForm type={meeting.channel === 'phone' ? 'phone' : 'in_person'} initial={meeting} submitLabel="Save Changes" onSubmit={async (input) => {
            await updateScheduledMeeting(meeting.id, input);
            navigate('/', { replace: true });
          }} />}
      </main>
    </div>
  );
}
