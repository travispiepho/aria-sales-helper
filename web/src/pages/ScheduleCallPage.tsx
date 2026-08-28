import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader';
import ScheduledMeetingForm from '../components/ScheduledMeetingForm';
import { createScheduledMeeting } from '../lib/api';

export default function ScheduleCallPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-gray-200">
      <AppHeader title="Schedule a Call" backTo="/schedule" backLabel="Back to Schedule" />
      <main className="px-4 -mt-2 pb-24 max-w-lg mx-auto">
        <ScheduledMeetingForm type="phone" onSubmit={async (input) => {
          await createScheduledMeeting(input);
          navigate('/', { replace: true });
        }} />
      </main>
    </div>
  );
}
