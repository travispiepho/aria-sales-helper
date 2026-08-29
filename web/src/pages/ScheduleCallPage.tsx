import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppPageLayout from '../components/AppPageLayout';
import ScheduledMeetingForm from '../components/ScheduledMeetingForm';
import { createScheduledMeeting } from '../lib/api';

export default function ScheduleCallPage() {
  const navigate = useNavigate();
  return (
    <AppPageLayout
      title="Schedule a Call"
      backTo="/schedule"
      backLabel="Back to Schedule"
      contentClassName="max-w-lg mx-auto"
    >
      <ScheduledMeetingForm type="phone" onSubmit={async (input) => {
        await createScheduledMeeting(input);
        navigate('/', { replace: true });
      }} />
    </AppPageLayout>
  );
}
