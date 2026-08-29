import React from 'react';
import { useNavigate } from 'react-router-dom';
import AppPageLayout from '../components/AppPageLayout';
import ScheduledMeetingForm from '../components/ScheduledMeetingForm';
import { createScheduledMeeting } from '../lib/api';

export default function ScheduleVisitPage() {
  const navigate = useNavigate();
  return (
    <AppPageLayout
      title="Schedule a Visit"
      backTo="/schedule"
      backLabel="Back to Schedule"
      contentClassName="max-w-lg mx-auto"
    >
      <ScheduledMeetingForm type="in_person" onSubmit={async (input) => {
        await createScheduledMeeting(input);
        navigate('/', { replace: true });
      }} />
    </AppPageLayout>
  );
}
