import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cancelScheduledMeeting, listScheduledMeetings, Meeting, startScheduledMeeting } from '../lib/api';
import { inRecordingPath } from '../lib/meetingRoutes';
import { formatScheduledTime } from '../lib/scheduleTime';
import PhoneCallModal from './PhoneCallModal';

export default function UpcomingMeetings() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [phoneMeeting, setPhoneMeeting] = useState<Meeting | null>(null);

  useEffect(() => {
    let cancelled = false;
    listScheduledMeetings()
      .then(({ meetings: values }) => { if (!cancelled) setMeetings(values); })
      .catch(() => { if (!cancelled) setError("Couldn't load upcoming meetings."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function start(meeting: Meeting) {
    if (meeting.channel === 'phone') {
      setPhoneMeeting(meeting);
      return;
    }
    setBusyId(meeting.id);
    try {
      const started = await startScheduledMeeting(meeting.id);
      navigate(inRecordingPath(started.id));
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : 'Could not start this meeting.');
      setBusyId(null);
    }
  }

  async function cancel(meeting: Meeting) {
    if (!confirm(`Cancel “${meeting.title || 'this meeting'}”?`)) return;
    setBusyId(meeting.id);
    try {
      await cancelScheduledMeeting(meeting.id);
      setMeetings((values) => values.filter((value) => value.id !== meeting.id));
    } catch (cause) {
      alert(cause instanceof Error ? cause.message : 'Could not cancel this meeting.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="upcoming-meetings-heading" className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 id="upcoming-meetings-heading" className="font-semibold text-gray-900">Upcoming scheduled meetings</h2>
        <button onClick={() => navigate('/schedule')} className="min-h-11 px-2 text-sm font-semibold text-brand-700">Schedule</button>
      </div>
      {loading ? <div role="status" className="bg-white rounded-2xl p-4 text-sm text-gray-500">Loading upcoming meetings…</div> :
        error ? <div role="alert" className="bg-white rounded-2xl p-4 text-sm text-red-700">{error}</div> :
        meetings.length === 0 ? <div className="bg-white rounded-2xl border border-gray-100 p-4 text-sm text-gray-500">Nothing scheduled yet.</div> :
        <div className="space-y-3">{meetings.map((meeting) => <article key={meeting.id} className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
          <div className="flex gap-3 justify-between">
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 truncate">{meeting.title}</p>
              <p className="text-sm text-gray-600 mt-0.5">{meeting.scheduled_for && formatScheduledTime(meeting.scheduled_for)}</p>
              <p className="text-xs text-gray-500 mt-1 truncate">{meeting.channel === 'phone' ? '📞 Call' : '🚗 Visit'} · {meeting.scheduled_customer_name}</p>
              {meeting.scheduled_customer_address && <p className="text-xs text-gray-400 truncate">{meeting.scheduled_customer_address}</p>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <button disabled={busyId === meeting.id} onClick={() => start(meeting)} className="min-h-11 bg-brand-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">Start</button>
            <button disabled={busyId === meeting.id} onClick={() => navigate(`/schedule/${encodeURIComponent(meeting.id)}/edit`)} className="min-h-11 border border-gray-200 rounded-xl text-sm font-semibold disabled:opacity-50">Edit</button>
            <button disabled={busyId === meeting.id} onClick={() => cancel(meeting)} className="min-h-11 border border-red-200 text-red-700 rounded-xl text-sm font-semibold disabled:opacity-50">Cancel</button>
          </div>
        </article>)}</div>}
      {phoneMeeting && <PhoneCallModal
        initialCustomerPhone={phoneMeeting.scheduled_customer_phone || ''}
        scheduledMeetingId={phoneMeeting.id}
        onClose={() => setPhoneMeeting(null)}
        onMeetingReady={(callMeetingId) => {
          setPhoneMeeting(null);
          navigate(inRecordingPath(callMeetingId));
        }}
      />}
    </section>
  );
}
