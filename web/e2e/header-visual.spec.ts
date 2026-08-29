import { expect, test } from '@playwright/test';

const mockUser = {
  id: 'visual-rep',
  name: 'Gabe Rivera',
  email: 'gabe@example.test',
  role: 'admin',
  phone: '+16165550111',
};

async function mockAuthenticatedApi(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') {
      return route.fulfill({ json: { user: mockUser } });
    }
    if (url.pathname === '/api/meetings') {
      return route.fulfill({ json: { meetings: [], hasMore: false, limit: 20, offset: 0 } });
    }
    if (url.pathname === '/api/scheduled-meetings') {
      return route.fulfill({ json: { meetings: [] } });
    }
    if (url.pathname === '/api/meetings/scheduled-layout-test') {
      return route.fulfill({ json: {
        id: 'scheduled-layout-test', rep_id: mockUser.id, status: 'active', channel: 'in_person',
        started_at: '2026-08-29T14:30:00.000Z', scheduled_for: '2026-08-29T14:30:00.000Z',
        scheduled_customer_name: 'Jane Smith', scheduled_customer_address: '123 Main St', title: 'Estimate',
      } });
    }
    if (url.pathname === '/api/profile/voice-print') {
      return route.fulfill({ json: { enrolled: false } });
    }
    if (url.pathname === '/api/admin/users') {
      return route.fulfill({ json: { users: [mockUser] } });
    }
    if (url.pathname === '/api/admin/invites') {
      return route.fulfill({ json: { invites: [] } });
    }
    if (url.pathname === '/api/objections') {
      return route.fulfill({ json: { objections: [] } });
    }
    return route.fulfill({ status: 404, json: { error: `Unmocked ${url.pathname}` } });
  });
}

test.beforeEach(async ({ page }) => mockAuthenticatedApi(page));

async function waitForAuthenticatedHeader(page: import('@playwright/test').Page, title?: string) {
  await expect.poll(async () => {
    const header = page.locator('[data-app-header="compact"]');
    return {
      header: await header.count(),
      navigation: await header.getByRole('navigation', { name: 'Authenticated navigation' }).count(),
      title: title ? await header.getByRole('heading', { name: title, exact: true }).count() : 1,
      objectionsIcon: await header.locator('svg[data-nav-icon="objections"]').count(),
    };
  }).toEqual({ header: 1, navigation: 1, title: 1, objectionsIcon: 1 });
}

const authenticatedRoutes = [
  '/',
  '/meetings',
  '/profile',
  '/admin/users',
  '/settings',
  '/schedule',
  '/schedule/call',
  '/schedule/visit',
  '/objections',
];

test('authenticated route canvases use gray-200 with white content panels', async ({ page }) => {
  for (const route of authenticatedRoutes) {
    await page.goto(`http://127.0.0.1:5173${route}`);
    const canvas = page.locator('#root > div').first();
    await expect(canvas).toHaveCSS('background-color', 'rgb(229, 231, 235)');
    const whitePanel = canvas.locator('.bg-white').first();
    if (await whitePanel.count()) {
      await expect(whitePanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    }
  }
});

for (const [route, title] of [
  ['/settings', 'Settings'],
  ['/objections', 'Objections'],
  ['/meetings', 'Meetings'],
  ['/', 'ARIA'],
] as const) {
  test(`${route} retains the current-page title without a separate ARIA brand link`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:5173${route}`);
    await waitForAuthenticatedHeader(page, title);
    const header = page.locator('[data-app-header="compact"]');
    await expect(header.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(header.locator('h1')).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Home' })).toHaveCount(0);
    const objections = header.getByRole('link', { name: 'Objections' });
    await expect(objections.locator('svg[data-nav-icon="objections"]')).toBeVisible();
    await expect(objections).not.toContainText('💬');
  });
}

test('desktop shared compact header evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:5173/settings');
  const header = page.locator('[data-app-header="compact"]');
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute('data-compact-min-height', '104px');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  const objections = page.getByRole('link', { name: 'Objections' });
  await expect(objections.locator('svg[data-nav-icon="objections"]')).toBeVisible();
  await expect(objections).not.toContainText('💬');
  await page.screenshot({ path: 'test-results/shared-header-desktop-settings.png', fullPage: true });
});

test('narrow header wraps without hiding navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto('http://127.0.0.1:5173/schedule/call');
  const header = page.locator('[data-app-header="compact"]');
  await expect(header).toBeVisible();
  for (const name of ['Meet', 'Recorded', 'Objections', 'Settings', 'Profile']) {
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Schedule a Call' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to Schedule' })).toHaveCount(0);
  const boxes = await Promise.all([
    page.getByRole('link', { name: 'Meet' }).boundingBox(),
    page.getByRole('link', { name: 'Recorded' }).boundingBox(),
    page.getByRole('link', { name: 'Settings' }).boundingBox(),
    page.getByRole('link', { name: 'Objections' }).boundingBox(),
    page.getByRole('link', { name: 'Profile' }).boundingBox(),
  ]);
  for (const box of boxes) {
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBe(44);
    expect((box?.x || 0) + (box?.width || 0)).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: 'test-results/shared-header-mobile-schedule-call.png', fullPage: true });
});


test('Meet and Recorded preserve homepage and history routing and current state', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/meetings');
  await expect(page.getByRole('link', { name: 'Recorded' })).toHaveAttribute('href', '/meetings');
  await expect(page.getByRole('link', { name: 'Recorded' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Meet' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5173/');
  await expect(page.getByRole('heading', { name: 'ARIA' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Meet' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Meet' })).toHaveAttribute('aria-current', 'page');

  const labels = await page
    .getByRole('navigation', { name: 'Authenticated navigation' })
    .locator('a')
    .evaluateAll(links => links.map(link => link.getAttribute('aria-label')));
  expect(labels).toEqual(['Meet', 'Recorded', 'Objections', 'Settings', 'Profile']);
});


test.describe('Home, Objections, and Meetings flow layout', () => {
  for (const viewport of [
    { name: 'phone', width: 320, height: 760 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    for (const route of ['/', '/objections', '/meetings']) {
      test(`${viewport.name} ${route}: navigation finishes before the page's first content`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`http://127.0.0.1:5173${route}`);
        await waitForAuthenticatedHeader(page);
        const header = page.locator('[data-app-header="compact"]');
        const navigation = page.getByRole('navigation', { name: 'Authenticated navigation' });
        const content = page.locator('[data-page-content]');
        await expect(content).toBeVisible();
        await expect(navigation).toBeVisible();
        const firstContent = content.locator(':scope > *').first();

        await expect(header).toHaveCSS('position', 'static');
        await expect(navigation).toHaveCSS('position', 'static');
        await expect(content).toHaveCSS('position', 'static');
        await expect(firstContent).toBeVisible();

        const [headerBox, navigationBox, contentBox, firstBox] = await Promise.all([
          header.boundingBox(),
          navigation.boundingBox(),
          content.boundingBox(),
          firstContent.boundingBox(),
        ]);
        expect(headerBox && contentBox && headerBox.y + headerBox.height <= contentBox.y).toBeTruthy();
        expect(navigationBox && contentBox && navigationBox.y + navigationBox.height <= contentBox.y).toBeTruthy();
        expect(contentBox && firstBox && contentBox.y <= firstBox.y).toBeTruthy();
      });
    }
  }
});


test.describe('Schedule Ahead route and substate flow layout', () => {
  const scheduleStates = [
    { name: 'entry', route: '/schedule', first: 'What are you scheduling?' },
    { name: 'call-details', route: '/schedule/call', first: 'Scheduled meeting details' },
    { name: 'visit-details', route: '/schedule/visit', first: 'Scheduled meeting details' },
    { name: 'edit-details', route: '/schedule/scheduled-layout-test/edit', first: 'Scheduled meeting details' },
  ];

  for (const viewport of [
    { name: 'phone', width: 320, height: 760 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    for (const state of scheduleStates) {
      test(`${viewport.name} ${state.name}: content is in flow below the complete navigation`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`http://127.0.0.1:5173${state.route}`);

        const header = page.locator('[data-app-header="compact"]');
        const navigation = page.getByRole('navigation', { name: 'Authenticated navigation' });
        const content = page.locator('[data-page-content]');
        const firstContent = content.locator(':scope > *').first();
        if (state.first === 'Scheduled meeting details') {
          await expect(page.getByRole('form', { name: state.first })).toBeVisible();
        } else {
          await expect(page.getByRole('heading', { name: state.first })).toBeVisible();
        }

        for (const element of [header, navigation, content, firstContent]) {
          await expect(element).toHaveCSS('position', 'static');
        }
        const [headerBox, navigationBox, contentBox, firstBox] = await Promise.all([
          header.boundingBox(), navigation.boundingBox(), content.boundingBox(), firstContent.boundingBox(),
        ]);
        expect(headerBox && contentBox && headerBox.y + headerBox.height <= contentBox.y).toBeTruthy();
        expect(navigationBox && contentBox && navigationBox.y + navigationBox.height <= contentBox.y).toBeTruthy();
        expect(contentBox && firstBox && contentBox.y <= firstBox.y).toBeTruthy();
      });
    }

    test(`${viewport.name} visit validation: error remains in the in-flow details form`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.route('**/api/scheduled-meetings', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 400, json: { error: 'Scheduled meetings must be in the future.' } })
        : route.fallback());
      await page.goto('http://127.0.0.1:5173/schedule/visit');
      await page.getByLabel('Meeting title').fill('Estimate');
      await page.getByLabel('Customer or contact name').fill('Jane');
      await page.getByRole('button', { name: 'Schedule Meeting' }).click();
      const form = page.getByRole('form', { name: 'Scheduled meeting details' });
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('future');
      await expect(form).toHaveCSS('position', 'static');
      expect(await form.evaluate((node, child) => node.contains(child), await alert.elementHandle())).toBe(true);
    });
  }
});
