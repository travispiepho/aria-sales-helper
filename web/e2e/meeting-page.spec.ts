// MeetingPage UI regression test — 2026-08-17 outbound-call diagnosis task.
// Covers the three states Gabe's production report + this task's fixes
// touch: phone-recording, phone-not-recording, in-person. Run at
// 390x844 (iPhone 12-ish) against the mocked backend in mock-server.mjs.
//
// Run: MOCK_PORT=4100 node e2e/mock-server.mjs &
//      VITE_API_URL=http://localhost:4100 npm run build && npx serve -l 4200 dist &
//      npx playwright test e2e/meeting-page.spec.ts
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const BASE = process.env.WEB_BASE_URL || 'http://localhost:4200';

test('phone call, recording in progress: shows Recording (Twilio) indicator, Hang Up button, sane timer, and NOT the record-to-see-transcript empty state', async ({ page }) => {
  await page.goto(`${BASE}/meetings/phone-recording`);
  await expect(page.getByText('Recording (Twilio)')).toBeVisible();
  await expect(page.getByText('📞 Hang Up')).toBeVisible();
  await expect(page.getByText('End Meeting', { exact: false })).toHaveCount(0);
  // Header timer: must NOT contain the broken "-1:-1" pattern, and must be
  // a real "Active · m:ss" or "Recording · m:ss" shaped string.
  const header = page.getByText(/^(Active|Recording) · \d+:\d{2}$/);
  await expect(header).toBeVisible();
  await expect(header).not.toContainText('-1:-1');
  // Live transcript empty state should reflect the phone-call-specific
  // copy, NOT the generic "Start recording to see live transcript" (which
  // told Gabe to tap a control that does not exist for a phone call).
  await expect(page.getByText('Start recording to see live transcript')).toHaveCount(0);
});

test('phone call, not yet recording: shows waiting state, Hang Up button, no crash on timer', async ({ page }) => {
  await page.goto(`${BASE}/meetings/phone-not-recording`);
  await expect(page.getByText('Waiting to record…')).toBeVisible();
  await expect(page.getByText('📞 Hang Up')).toBeVisible();
  const header = page.getByText(/^(Active|Recording) · \d+:\d{2}$/);
  await expect(header).toBeVisible();
  await expect(header).not.toContainText('-1:-1');
  await expect(page.getByText('Waiting for the customer to answer…')).toBeVisible();
});

test('in-person meeting: keeps functional End Meeting button, Record button, generic transcript copy', async ({ page }) => {
  await page.goto(`${BASE}/meetings/in-person`);
  await expect(page.getByText('⏹ End Meeting')).toBeVisible();
  await expect(page.getByText('📞 Hang Up')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Record/ })).toBeVisible();
  await expect(page.getByText('Start recording to see live transcript')).toBeVisible();
});

test.describe('browser call live meeting surface', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps transcript/coaching rendered with compact mute and hang-up controls', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('aria.browserCall.meetingId', 'browser-live');
    });
    await page.goto(`${BASE}/meetings/browser-live`);
    await expect(page.getByRole('heading', { name: 'Live Transcript' })).toBeVisible();
    await expect(page.getByText('I can see the live transcript.')).toBeVisible();
    await expect(page.getByLabel('Browser call controls')).toBeVisible();
    await expect(page.getByText(/Browser call · Call ended/)).toBeVisible();
    await expect(page.getByText(/ARIA coaching will appear/i)).toBeVisible();
    await page.screenshot({ path: 'test-results/browser-call-live-desktop.png', fullPage: true });
  });
});

test.describe('browser call live meeting at 320px', () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test('compact controls do not cover transcript content', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('aria.browserCall.meetingId', 'browser-live');
    });
    await page.goto(`${BASE}/meetings/browser-live`);
    const controls = page.getByLabel('Browser call controls');
    const transcript = page.getByText('I can see the live transcript.');
    await expect(controls).toBeVisible();
    await expect(transcript).toBeVisible();
    const controlsBox = await controls.boundingBox();
    const transcriptBox = await transcript.boundingBox();
    expect(controlsBox && transcriptBox && controlsBox.y + controlsBox.height <= transcriptBox.y).toBeTruthy();
    await page.screenshot({ path: 'test-results/browser-call-live-320.png', fullPage: true });
  });
});

// 2026-08-18 (Deepgram reconnect hardening) — BEHAVIORAL verification (not
// a code-path trace) that a server-pushed transcription_lapse message
// actually renders the lapse/recovery/terminal notices inline in the
// transcript UI. Uses the mock server's /test/push/:meetingId endpoint
// (see mock-server.mjs) to inject the exact WS message shape
// broadcastToMeeting() sends in production, over an ALREADY-CONNECTED
// socket — this is the same class of check the 8/17 postmortem says was
// missing (a subagent traced code instead of exercising the UI and was
// wrong about what the rep actually saw).
const PUSH_BASE = process.env.MOCK_BASE_URL || 'http://localhost:4100';

test('phone call: >2s lapse notice, recovery notice, and terminal stopped notice all render inline in the transcript', async ({ page }) => {
  await page.goto(`${BASE}/meetings/phone-recording`);
  // Give the owner audio WebSocket a moment to actually open (this is the
  // exact condition the 8/17 postmortem flags: pushing to a socket that
  // never connected produces a silent stall). Poll the mock server's
  // socket registry indirectly by waiting for the connection status pill.
  await expect(page.getByText(/Recording ·|Active ·/)).toBeVisible({ timeout: 5000 });

  // Push a lapse-start notice, exactly as server/telephony.js's
  // onLapseStart callback broadcasts it.
  const startRes = await fetch(`${PUSH_BASE}/test/push/phone-recording`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transcription_lapse', state: 'started', startedAt: Date.now() }),
  });
  expect((await startRes.json()).sent).toBeGreaterThan(0);
  await expect(page.getByText('Connection lost — live transcription paused. Recording continues.')).toBeVisible();

  // Push the matching recovery notice with an observed duration.
  const endRes = await fetch(`${PUSH_BASE}/test/push/phone-recording`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transcription_lapse', state: 'recovered', durationMs: 4300 }),
  });
  expect((await endRes.json()).sent).toBeGreaterThan(0);
  await expect(page.getByText(/Reconnected.*live transcription was paused for 4s/)).toBeVisible();

  // Push the terminal 60s-budget-exhaustion notice.
  const stopRes = await fetch(`${PUSH_BASE}/test/push/phone-recording`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transcription_lapse', state: 'stopped' }),
  });
  expect((await stopRes.json()).sent).toBeGreaterThan(0);
  await expect(page.getByText(/Live transcription has stopped for this meeting\. The recording is still being captured/)).toBeVisible();
});
