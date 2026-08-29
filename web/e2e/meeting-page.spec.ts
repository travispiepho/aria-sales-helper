// MeetingPage UI regression test — 2026-08-17 outbound-call diagnosis task.
// Covers the three states Gabe's production report + this task's fixes
// touch: phone-recording, phone-not-recording, in-person. Run at
// 390x844 (iPhone 12-ish) against the mocked backend in mock-server.mjs.
//
// Run: MOCK_PORT=4100 node e2e/mock-server.mjs &
//      VITE_API_URL=http://localhost:4100 npm run build && npx serve -l 4200 dist &
//      npx playwright test e2e/meeting-page.spec.ts
import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const BASE = process.env.WEB_BASE_URL || 'http://localhost:4200';

async function expectViewportWorkspace(page: Page, expectedTypeLabel: string) {
  const workspace = page.locator('[data-active-meeting-layout="three-column"]');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator(':scope > [data-meeting-column]')).toHaveCount(3);
  await expect(page.getByRole('region', { name: expectedTypeLabel })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ARIA Feedback' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'ARIA Coaching' })).toBeVisible();
  const renameBox = await workspace.locator('[data-speaker-controls]').boundingBox();
  const transcriptBox = await workspace.locator('[data-live-transcript]').boundingBox();
  expect(renameBox && transcriptBox && renameBox.y + renameBox.height <= transcriptBox.y).toBeTruthy();
  const layout = await page.evaluate(() => {
    const feedback = document.querySelector('[data-aria-feedback-panel]')!.getBoundingClientRect();
    const transcript = document.querySelector('[aria-label="Live Transcript content"], [aria-label="Live transcript"]')!;
    const checklist = document.querySelector('[data-coaching-checklist]');
    const checklistItems = Array.from(document.querySelectorAll('[data-coaching-checklist-item]'));
    const checklistRows = new Set(checklistItems.map(item => Math.round(item.getBoundingClientRect().y)));
    const hasOverflow = checklistItems.some(item => {
      const box = item.getBoundingClientRect();
      return box.left < feedback.left || box.right > feedback.right;
    });
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
      bodyHeight: document.body.scrollHeight,
      bodyViewportHeight: document.body.clientHeight,
      feedbackX: feedback.x,
      feedbackY: feedback.y,
      feedbackWidth: feedback.width,
      feedbackCenter: feedback.x + feedback.width / 2,
      viewportCenter: window.innerWidth / 2,
      transcriptOverflowY: getComputedStyle(transcript).overflowY,
      checklistDisplay: checklist ? getComputedStyle(checklist).display : null,
      checklistCount: checklistItems.length,
      checklistRows: checklistRows.size,
      checklistOverflow: hasOverflow,
    };
  });
  expect(layout.documentHeight).toBe(layout.viewportHeight);
  expect(layout.bodyHeight).toBe(layout.bodyViewportHeight);
  expect(layout.feedbackWidth).toBe(736);
  expect(layout.feedbackX).toBe(layout.viewportCenter - 368);
  expect(layout.feedbackY).toBe(120);
  expect(layout.feedbackCenter).toBe(layout.viewportCenter);
  expect(layout.transcriptOverflowY).toBe('auto');
  if (layout.checklistCount > 0) {
    expect(layout.checklistDisplay).toBe('grid');
    expect(layout.checklistCount).toBe(11);
    expect(layout.checklistRows).toBeGreaterThan(1);
    expect(layout.checklistOverflow).toBe(false);
    await expect(page.getByText('3/11', { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Authenticated navigation' })).toHaveCount(0);
}

async function expectWaitingCoachingSections(page: Page) {
  const panel = page.getByRole('region', { name: 'ARIA Coaching' });
  for (const section of ['disc', 'urgent', 'stage', 'checklist', 'nudges']) {
    await expect(panel.locator(`[data-coaching-waiting="${section}"]`)).toHaveText('Waiting on data...');
  }
}

// 2026-08-29 (coaching-panel full-height / no-collapse task) — the panel
// must never have a collapse/minimize chevron button, and its rendered
// height must not shrink just because every section is showing a
// "Waiting on data..." placeholder instead of real content.
async function expectCoachingPanelNeverCollapses(page: Page) {
  await expect(page.getByRole('button', { name: /ARIA Coaching/ })).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'ARIA Coaching' });
  await expect(panel).toBeVisible();
  const feedbackColumn = page.locator('[data-meeting-column="feedback"]');
  const panelBox = await panel.boundingBox();
  const columnBox = await feedbackColumn.boundingBox();
  expect(panelBox && columnBox).toBeTruthy();
  // The panel must fill essentially the full height of its column slot
  // (allow a couple of px of rounding slop), whether it's all placeholders
  // or has real data — it must never shrink to header-only height.
  expect(panelBox!.height).toBeGreaterThan(200);
  expect(Math.abs(panelBox!.height - columnBox!.height)).toBeLessThanOrEqual(2);
}

async function expectNoDedicatedStatusBanner(page: Page) {
  await expect(page.getByText('🔴 RECORDING — keep screen on')).toHaveCount(0);
  await expect(page.getByText('📱 LIVE — synced from mobile device')).toHaveCount(0);
  await expect(page.locator('[data-meeting-status-location="app-header"]')).toBeVisible();
}

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
    await expect(page.getByText(/Browser call · (Call ended|Finalizing meeting…)/)).toBeVisible();
    await expect(page.getByText(/ARIA coaching will appear|ARIA Coaching/i).first()).toBeVisible();
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


test.describe('desktop active meeting three-column viewport contract', () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });
      test('in-person fits without document overflow', async ({ page }) => {
        await page.goto(`${BASE}/meetings/in-person/active`);
        await expectViewportWorkspace(page, 'In-person meeting controls');
        await expectWaitingCoachingSections(page);
        await expectCoachingPanelNeverCollapses(page);
        await expectNoDedicatedStatusBanner(page);
        await expect(page.locator('[data-meeting-column="type"] [data-meeting-end-control]')).toBeVisible();
      });
      test('phone fits without document overflow and keeps hang-up guidance', async ({ page }) => {
        await page.goto(`${BASE}/meetings/phone-recording/active`);
        await expectViewportWorkspace(page, 'Phone meeting controls');
        await expectWaitingCoachingSections(page);
        await expectCoachingPanelNeverCollapses(page);
        await expectNoDedicatedStatusBanner(page);
        await expect(page.getByText('Recording (Twilio)')).toBeVisible();
        await expect(page.getByText('Hang up your phone to end this meeting.')).toBeVisible();
      });
      test('uploaded recording fits without document overflow', async ({ page }) => {
        await page.goto(`${BASE}/recordings/analyze`);
        await expectViewportWorkspace(page, 'Playback and analysis controls');
        await expectWaitingCoachingSections(page);
        await expectCoachingPanelNeverCollapses(page);
        await expect(page.getByText('🔴 RECORDING — keep screen on')).toHaveCount(0);
        await expect(page.getByText('📱 LIVE — synced from mobile device')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Choose a recording' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Playback & analysis controls' })).toBeVisible();
      });
    });
  }
});


test.describe('observer synced meeting status', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('keeps mobile-sync truth in compact existing surfaces, not a top banner', async ({ page }) => {
    await page.goto(`${BASE}/meetings/mobile-sync/active`);
    await expectViewportWorkspace(page, 'In-person meeting controls');
    await expectNoDedicatedStatusBanner(page);
    await expect(page.locator('[data-meeting-status-location="app-header"]')).toContainText('Synced from mobile');
    await expect(page.getByText('Live from phone')).toBeVisible();
    await expect(page.getByText('Synced from mobile', { exact: true })).toBeVisible();
  });
});

test.describe('owner microphone recording status', () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test('starts recording without restoring the removed top banner and keeps compact truthful indicators', async ({ page }) => {
    await page.addInitScript(() => {
      class FakeAudioContext {
        audioWorklet = { addModule: async () => {} };
        destination = {};
        createMediaStreamSource() { return { connect() {} }; }
        close() { return Promise.resolve(); }
      }
      class FakeAudioWorkletNode {
        port = { onmessage: null };
        connect() {}
        disconnect() {}
      }
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
      });
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: { request: async () => ({ release: async () => {} }) },
      });
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
      Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode });
    });

    await page.goto(`${BASE}/meetings/in-person/active`);
    await page.getByRole('button', { name: /Record/ }).click();
    await page.getByRole('button', { name: /Confirm/ }).click();

    await expect(page.locator('[data-meeting-status-location="app-header"]')).toContainText(/^Recording · /);
    await expect(page.getByText('Microphone recording live')).toBeVisible();
    await expect(page.getByText('🔴 RECORDING — keep screen on')).toHaveCount(0);
    const workspaceY = await page.locator('[data-active-meeting-layout="three-column"]').evaluate(element => element.getBoundingClientRect().y);
    expect(workspaceY).toBe(104);
  });
});
