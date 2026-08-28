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

test('desktop shared compact header evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:5173/settings');
  const header = page.locator('[data-app-header="compact"]');
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute('data-compact-min-height', '104px');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: 'test-results/shared-header-desktop-settings.png', fullPage: true });
});

test('narrow header wraps without hiding navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto('http://127.0.0.1:5173/schedule/call');
  const header = page.locator('[data-app-header="compact"]');
  await expect(header).toBeVisible();
  for (const name of ['Back to Schedule', 'Meetings', 'Settings', 'Objections', 'Profile']) {
    await expect(page.getByRole('link', { name })).toBeVisible();
  }
  const boxes = await Promise.all([
    page.getByRole('link', { name: 'Meetings' }).boundingBox(),
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


test.describe('Home, Objections, and Meetings flow layout', () => {
  for (const viewport of [
    { name: 'phone', width: 320, height: 760 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    test(`${viewport.name}: navigation finishes before each page's first content`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of ['/', '/objections', '/meetings']) {
        await page.goto(`http://127.0.0.1:5173${route}`);
        const header = page.locator('[data-app-header="compact"]');
        const navigation = page.getByRole('navigation', { name: 'Authenticated navigation' });
        const content = page.locator('[data-page-content]');
        await expect(content).toBeVisible();
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
      }
    });
  }
});
