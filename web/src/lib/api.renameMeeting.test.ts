import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameMeeting } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('renameMeeting', () => {
  it('PATCHes the authenticated meeting title once and verifies it with GET', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { id: 'meeting-1', title: 'Browser call title' }))
      .mockResolvedValueOnce(response(200, { id: 'meeting-1', title: 'Browser call title' }));
    vi.stubGlobal('fetch', fetchMock);

    const meeting = await renameMeeting('meeting-1', '  Browser call title  ', { retryDelayMs: 0 });

    expect(meeting.title).toBe('Browser call title');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/api\/meetings\/meeting-1$/), expect.objectContaining({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ title: 'Browser call title' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringMatching(/\/api\/meetings\/meeting-1$/), expect.objectContaining({
      method: 'GET',
      credentials: 'include',
    }));
  });

  it('retries a not-yet-created browser-call meeting without duplicate success writes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { error: 'Meeting not found' }))
      .mockResolvedValueOnce(response(200, { id: 'meeting-pending', title: 'Ready now' }))
      .mockResolvedValueOnce(response(200, { id: 'meeting-pending', title: 'Ready now' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(renameMeeting('meeting-pending', 'Ready now', { attempts: 2, retryDelayMs: 0 }))
      .resolves.toMatchObject({ title: 'Ready now' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('surfaces auth/server errors immediately and rejects failed readback', async () => {
    let fetchMock = vi.fn().mockResolvedValue(response(401, { error: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameMeeting('meeting-1', 'New title', { retryDelayMs: 0 })).rejects.toThrow('Unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { id: 'meeting-1', title: 'New title' }))
      .mockResolvedValueOnce(response(200, { id: 'meeting-1', title: 'Old title' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameMeeting('meeting-1', 'New title', { retryDelayMs: 0 })).rejects.toThrow('could not be verified');
  });

  it('rejects whitespace without sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameMeeting('meeting-1', '   ')).rejects.toThrow('cannot be empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
