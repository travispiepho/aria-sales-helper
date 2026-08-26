import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMeetingTitle, requireSingleMeetingUpdate } from '../meetingTitle.js';

test('normalizes a valid meeting title for browser and non-browser meetings', () => {
  assert.equal(normalizeMeetingTitle('  Kitchen repaint estimate  '), 'Kitchen repaint estimate');
});

for (const value of ['', '   ', null, 42]) {
  test(`rejects invalid meeting title ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => normalizeMeetingTitle(value),
      (error) => error.statusCode === 400 && error.message === 'Meeting title cannot be empty'
    );
  });
}

test('returns the one database row updated by the authenticated route', () => {
  const row = { id: 'meeting-1', title: 'Persisted title' };
  assert.equal(requireSingleMeetingUpdate({ rowCount: 1, rows: [row] }), row);
});

test('rejects a zero-row database race instead of reporting silent success', () => {
  assert.throws(
    () => requireSingleMeetingUpdate({ rowCount: 0, rows: [] }),
    (error) => error.statusCode === 409 && error.message.includes('Reload and try again')
  );
});
