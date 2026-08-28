// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import InRecordingPage from './InRecordingPage';

vi.mock('../lib/api', () => ({ getMeeting: vi.fn() }));
vi.mock('./MeetingPage', () => ({ default: () => <p>Shared live meeting</p> }));
vi.mock('./UploadedRecordingPage', () => ({
  default: ({ onMeetingStarted }: { onMeetingStarted?: (id: string) => void }) => {
    const navigate = useNavigate();
    return (
      <section aria-label="Uploaded recording workspace">
        <button onClick={() => { onMeetingStarted?.('upload-1'); navigate('/meetings/upload-1/active', { replace: true }); }}>
          Create upload meeting
        </button>
      </section>
    );
  },
}));

function Probe() { return <output aria-label="location">{useLocation().pathname}</output>; }

afterEach(cleanup);

describe('InRecordingPage upload composition', () => {
  it('moves an uploaded analysis into the canonical active URL without losing its local workspace', async () => {
    render(<MemoryRouter initialEntries={['/recordings/analyze']}><Routes>
      <Route element={<InRecordingPage />}>
        <Route path="/recordings/analyze" element={<Probe />} />
        <Route path="/meetings/:id/active" element={<Probe />} />
      </Route>
    </Routes></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Create upload meeting' }));
    expect(screen.getByLabelText('location').textContent).toBe('/meetings/upload-1/active');
    expect(screen.getByLabelText('Uploaded recording workspace')).toBeTruthy();
  });
});
