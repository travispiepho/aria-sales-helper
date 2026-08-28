import type { Meeting } from './api';

export function inRecordingPath(meetingId: string): string {
  return `/meetings/${encodeURIComponent(meetingId)}/active`;
}

export function postRecordingPath(meetingId: string): string {
  return `/meetings/${encodeURIComponent(meetingId)}/post`;
}

export function canonicalMeetingPath(meeting: Pick<Meeting, 'id' | 'status'>): string {
  return meeting.status === 'active'
    ? inRecordingPath(meeting.id)
    : postRecordingPath(meeting.id);
}
