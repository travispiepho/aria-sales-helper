import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { createMeeting, updateMeeting } from '../lib/api';
import CustomerIntakeModal from '../components/CustomerIntakeModal';
import PhoneCallModal from '../components/PhoneCallModal';
import AppHeader from '../components/AppHeader';

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [showIntake, setShowIntake] = useState(false);
  const [showPhoneCall, setShowPhoneCall] = useState(false);
  const [starting, setStarting] = useState(false);

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

  return (
    <div className="min-h-screen bg-gray-200">
      <AppHeader title="ARIA" subtitle={<>Hey {user?.name?.split(' ')[0]} 👋</>} />

      <div className="px-4 -mt-2 pb-24">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 mb-6">
          <h2 className="font-semibold text-gray-900 mb-1">Ready to meet?</h2>
          <p className="text-sm text-gray-500 mb-4">
            Start a meeting to capture the conversation and intake details.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setShowIntake(true)}
              disabled={starting}
              className="min-h-11 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              {starting ? 'Starting…' : '▶ Record a Visit'}
            </button>
            <button
              onClick={() => setShowPhoneCall(true)}
              disabled={starting}
              className="min-h-11 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-semibold py-3 rounded-xl transition-colors"
            >
              📞 Call a Customer
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            <button
              onClick={() => navigate('/schedule')}
              disabled={starting}
              className="min-h-11 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-semibold py-3 rounded-xl transition-colors"
            >
              🗓️ Schedule Ahead
            </button>
            <button
              onClick={() => navigate('/recordings/analyze')}
              disabled={starting}
              className="min-h-11 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-semibold py-3 rounded-xl transition-colors"
            >
              🎧 Analyze a Recording
            </button>
          </div>
        </div>
      </div>

      {showIntake && (
        <CustomerIntakeModal
          onClose={() => setShowIntake(false)}
          onCreated={(customerId, title) => {
            setShowIntake(false);
            handleStartMeeting(customerId, title);
          }}
        />
      )}

      {showPhoneCall && (
        <PhoneCallModal
          onClose={() => setShowPhoneCall(false)}
          onMeetingReady={(meetingId) => {
            setShowPhoneCall(false);
            navigate(`/meetings/${meetingId}`);
          }}
        />
      )}
    </div>
  );
}
