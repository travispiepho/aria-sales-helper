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
  const header = page.locator('h1', { hasText: 'Test Customer' }).locator('..').locator('p');
  await expect(header).not.toContainText('-1:-1');
  await expect(header).toContainText(/Active|Recording/);
  // Live transcript empty state should reflect the phone-call-specific
  // copy, NOT the generic "Start recording to see live transcript" (which
  // told Gabe to tap a control that does not exist for a phone call).
  await expect(page.getByText('Start recording to see live transcript')).toHaveCount(0);
});

test('phone call, not yet recording: shows waiting state, Hang Up button, no crash on timer', async ({ page }) => {
  await page.goto(`${BASE}/meetings/phone-not-recording`);
  await expect(page.getByText('Waiting to record…')).toBeVisible();
  await expect(page.getByText('📞 Hang Up')).toBeVisible();
  const header = page.locator('h1', { hasText: 'Test Customer 2' }).locator('..').locator('p');
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
