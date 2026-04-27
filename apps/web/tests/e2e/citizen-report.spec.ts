/**
 * E2E tests for the citizen need-reporting flow.
 * Uses Playwright with page.route() to mock Firebase / API responses.
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function mockAuthSession(page: Page) {
  await page.context().addCookies([
    {
      name: 'rahatnet_session', value: 'mock-session-token',
      domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Strict',
    },
  ]);

  await page.route('/api/auth/me', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { uid: 'test-uid', displayName: 'Test Citizen', role: 'CITIZEN', onboardingStatus: 'COMPLETED', district: 'Ernakulam', state: 'Kerala', language: 'en' },
        error: null, requestId: 'e2e',
      }),
    }),
  );

  await page.route('/api/needs', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { reportId: 'e2e-report-001' }, error: null, requestId: 'e2e' }),
      });
    } else {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20, hasMore: false }, error: null, requestId: 'e2e' }),
      });
    }
  });

  await page.route('/api/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'ok' }, error: null }) }),
  );
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

test.describe('Citizen report flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('login page renders correctly', async ({ page }) => {
    await expect(page.getByText('RahatNet')).toBeVisible();
    await expect(page.getByText('AI-powered disaster coordination')).toBeVisible();
  });

  test('redirects unauthenticated user to login', async ({ page }) => {
    await page.goto('/citizen/report');
    await expect(page).toHaveURL(/\/login/);
  });
});

// ---------------------------------------------------------------------------
// Full citizen flow (authenticated)
// ---------------------------------------------------------------------------

test.describe('Citizen report flow (authenticated)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthSession(page);
  });

  test('Step 1: select need type → advances to Step 2', async ({ page }) => {
    await page.goto('/citizen/report');
    await expect(page.getByText(/what do you need/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('radio', { name: /rescue/i }).click();
    await page.getByRole('button', { name: /next/i }).click();

    await expect(page.getByText(/describe the situation/i)).toBeVisible();
  });

  test('complete flow: select → describe → confirm → success', async ({ page }) => {
    await page.goto('/citizen/report');
    await expect(page.getByText(/what do you need/i)).toBeVisible({ timeout: 10_000 });

    // Step 1.
    await page.getByRole('radio', { name: /rescue/i }).click();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 2.
    await page.getByRole('textbox', { name: /or describe in text/i })
      .fill('Family stranded on rooftop, urgent rescue needed');
    await page.getByRole('button', { name: /next/i }).click();

    // Step 3.
    await expect(page.getByText(/confirm your report/i)).toBeVisible();
    await page.getByRole('button', { name: /submit report/i }).click();

    // Success.
    await expect(page.getByText(/report submitted/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/e2e-report-001/i)).toBeVisible();
  });

  test('success screen shows track + new report buttons', async ({ page }) => {
    await page.goto('/citizen/report');
    await expect(page.getByText(/what do you need/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('radio', { name: /food/i }).click();
    await page.getByRole('button', { name: /next/i }).click();
    await page.getByRole('textbox', { name: /or describe in text/i })
      .fill('Need food and clean water for flood victims');
    await page.getByRole('button', { name: /next/i }).click();
    await page.getByRole('button', { name: /submit report/i }).click();

    await expect(page.getByRole('button', { name: /track your report/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /report another need/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Offline flow
// ---------------------------------------------------------------------------

test.describe('Offline flow', () => {
  test('shows offline banner when network goes down', async ({ page }) => {
    await mockAuthSession(page);
    await page.goto('/citizen/report');
    await expect(page.getByText(/what do you need/i)).toBeVisible({ timeout: 10_000 });

    await page.context().setOffline(true);

    await expect(
      page.getByText(/you're offline/i).or(page.getByText(/reports will be saved/i)),
    ).toBeVisible({ timeout: 8_000 });
  });

  test('offline submission queues the report', async ({ page }) => {
    await mockAuthSession(page);
    await page.goto('/citizen/report');
    await expect(page.getByText(/what do you need/i)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('radio', { name: /shelter/i }).click();
    await page.getByRole('button', { name: /next/i }).click();
    await page.getByRole('textbox', { name: /or describe in text/i })
      .fill('Family needs temporary shelter, house flooded');
    await page.getByRole('button', { name: /next/i }).click();

    await page.context().setOffline(true);
    await page.getByRole('button', { name: /submit report/i }).click();

    await expect(
      page.getByText(/saved/i).or(page.getByText(/when you reconnect/i)),
    ).toBeVisible({ timeout: 10_000 });
  });
});
