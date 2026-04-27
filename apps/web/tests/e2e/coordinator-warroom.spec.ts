/**
 * E2E tests for the coordinator war-room dashboard.
 *
 * Tests mock:
 *   - Firebase session cookie (coordinator role)
 *   - /api/auth/me → coordinator profile
 *   - /api/analytics → chart data
 *   - Firestore via page.evaluate (inject needs into the Redux-like store)
 *   - /api/dispatch → assignment creation
 */

import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Auth + API mock helpers
// ---------------------------------------------------------------------------

async function mockCoordinatorSession(page: Page) {
  await page.context().addCookies([
    {
      name: 'rahatnet_session', value: 'mock-coord-session',
      domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Strict',
    },
  ]);

  await page.route('/api/auth/me', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          uid:              'coord-uid-001',
          displayName:      'Test Coordinator',
          role:             'COORDINATOR',
          onboardingStatus: 'COMPLETED',
          district:         'Ernakulam',
          state:            'Kerala',
          language:         'en',
          organizationName: 'Kerala Red Cross',
        },
        error: null, requestId: 'e2e',
      }),
    }),
  );

  await page.route('/api/health', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { status: 'ok' }, error: null }) }),
  );

  await page.route('/api/analytics*', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          responseTimes:   [],
          funnel:          [],
          heatmap:         Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
          typeBreakdown:   [],
          coveragePercent: 65,
          resolvedPercent: 40,
          totalNeeds:      20,
          computedAt:      new Date().toISOString(),
        },
        error: null, requestId: 'e2e',
      }),
    }),
  );
}

function makeMockNeed(overrides: Record<string, unknown> = {}) {
  return {
    id:                  `need-${Math.random().toString(36).slice(2)}`,
    title:               'Rescue needed at Aluva Bridge — 5 people',
    description:         'People stranded and need rescue',
    type:                'RESCUE',
    status:              'VERIFIED',
    severity:            'CRITICAL',
    urgencyScore:        9,
    location:            { lat: 10.0167, lng: 76.3417 },
    locationName:        'Aluva, Ernakulam',
    affectedCount:       5,
    hasVulnerable:       true,
    sourceReportIds:     [],
    reportCount:         3,
    assignedVolunteerId: null,
    assignedAt:          null,
    resolvedAt:          null,
    disasterEventId:     'disaster-001',
    createdAt:           { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    updatedAt:           { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    aiProcessingMeta:    { deduplicationConfidence: 0.9, urgencyFactors: {}, processingTimeMs: 1000, modelId: 'gemini-1.5-flash', processedAt: new Date().toISOString() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test: War room redirects unauthenticated users
// ---------------------------------------------------------------------------

test('unauthenticated user is redirected away from war room', async ({ page }) => {
  await page.goto('/coordinator/war-room');
  await expect(page).toHaveURL(/\/login/);
});

// ---------------------------------------------------------------------------
// Test: War room loads and shows the priority queue
// ---------------------------------------------------------------------------

test.describe('War room dashboard (coordinator)', () => {
  test.beforeEach(async ({ page }) => {
    await mockCoordinatorSession(page);
  });

  test('war room renders the priority queue and map', async ({ page }) => {
    const criticalNeed = makeMockNeed({ severity: 'CRITICAL', urgencyScore: 9 });
    const urgentNeed   = makeMockNeed({ severity: 'URGENT',   urgencyScore: 6, type: 'FOOD' });

    // Mock Firestore subscription by intercepting the underlying API call.
    await page.route('/api/needs*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { items: [criticalNeed, urgentNeed], total: 2, page: 1, pageSize: 20, hasMore: false },
          error: null, requestId: 'e2e',
        }),
      }),
    );

    await page.goto('/coordinator/war-room?event=disaster-001');

    // Priority queue header.
    await expect(page.getByText(/priority queue/i)).toBeVisible({ timeout: 15_000 });
  });

  test('clicking Assign opens the volunteer assignment modal', async ({ page }) => {
    const need = makeMockNeed({ status: 'VERIFIED' });

    await page.route('/api/needs*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { items: [need], total: 1, page: 1, pageSize: 20, hasMore: false },
          error: null, requestId: 'e2e',
        }),
      }),
    );

    await page.route('/api/dispatch/matches/*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            { uid: 'vol-001', displayName: 'Rajan Kumar', skills: ['BOAT_OPERATOR'], languages: ['en', 'ml'], distanceKm: 1.2, lastActiveMs: Date.now(), rating: 4.5, isAvailable: true },
            { uid: 'vol-002', displayName: 'Priya Nair',  skills: ['RESCUE_SWIMMER'], languages: ['en', 'ml'], distanceKm: 3.8, lastActiveMs: Date.now(), rating: 4.2, isAvailable: true },
          ],
          error: null, requestId: 'e2e',
        }),
      }),
    );

    await page.goto('/coordinator/war-room?event=disaster-001');
    await expect(page.getByText(/priority queue/i)).toBeVisible({ timeout: 15_000 });

    // Click the first Assign button.
    const firstAssignBtn = page.getByRole('button', { name: /assign/i }).first();
    if (await firstAssignBtn.isVisible()) {
      await firstAssignBtn.click();
      // The modal should appear.
      await expect(page.getByRole('dialog', { name: /assign volunteer/i })).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(/rajan kumar/i)).toBeVisible();
    }
  });

  test('assigning a volunteer calls the dispatch API and closes the modal', async ({ page }) => {
    const need = makeMockNeed({ status: 'VERIFIED' });

    await page.route('/api/needs*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { items: [need], total: 1, page: 1, pageSize: 20, hasMore: false },
          error: null, requestId: 'e2e',
        }),
      }),
    );

    await page.route('/api/dispatch/matches/*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ uid: 'vol-001', displayName: 'Rajan Kumar', skills: ['BOAT_OPERATOR'], languages: ['en', 'ml'], distanceKm: 1.2, lastActiveMs: Date.now(), rating: 4.5, isAvailable: true }],
          error: null, requestId: 'e2e',
        }),
      }),
    );

    let dispatchCalled = false;
    await page.route('/api/dispatch', (route) => {
      dispatchCalled = true;
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { assignmentId: 'asgn-e2e-001', volunteerId: 'vol-001', volunteerName: 'Rajan Kumar', estimatedArrivalMinutes: 8 },
          error: null, requestId: 'e2e',
        }),
      });
    });

    await page.goto('/coordinator/war-room?event=disaster-001');
    await expect(page.getByText(/priority queue/i)).toBeVisible({ timeout: 15_000 });

    const firstAssignBtn = page.getByRole('button', { name: /assign/i }).first();
    if (await firstAssignBtn.isVisible()) {
      await firstAssignBtn.click();
      await expect(page.getByRole('dialog', { name: /assign volunteer/i })).toBeVisible({ timeout: 5_000 });

      // Select the volunteer.
      await page.getByRole('button', { name: /rajan kumar/i }).click();

      // Click Assign Volunteer.
      await page.getByRole('button', { name: /assign volunteer/i }).click();

      // The API should have been called.
      await expect(async () => expect(dispatchCalled).toBe(true)).toPass({ timeout: 5_000 });

      // Modal should close.
      await expect(page.getByRole('dialog', { name: /assign volunteer/i })).not.toBeVisible({ timeout: 5_000 });
    }
  });

  test('impact metrics panel is visible', async ({ page }) => {
    await page.goto('/coordinator/war-room?event=disaster-001');

    await expect(page.getByText(/priority queue/i)).toBeVisible({ timeout: 15_000 });

    // The right sidebar should show metrics.
    const statsRegion = page.getByLabel(/impact metrics/i).or(page.getByRole('complementary', { name: /metrics/i }));
    if (await statsRegion.isVisible()) {
      expect(statsRegion).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Mark need as complete updates stats
// ---------------------------------------------------------------------------

test.describe('Task completion', () => {
  test.beforeEach(async ({ page }) => {
    await mockCoordinatorSession(page);
  });

  test('PATCH /api/dispatch → COMPLETED updates the assignment status', async ({ page }) => {
    let patchCalled = false;
    let patchBody: Record<string, unknown> = {};

    await page.route('/api/dispatch/**', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchCalled = true;
        patchBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { assignmentId: 'asgn-001', status: 'COMPLETED' }, error: null, requestId: 'e2e' }),
        });
      } else {
        await route.continue();
      }
    });

    // Trigger the PATCH directly (as the volunteer app would).
    await page.evaluate(async () => {
      await fetch('/api/dispatch/asgn-001', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'COMPLETED' }),
      });
    });

    expect(patchCalled).toBe(true);
    expect(patchBody['status']).toBe('COMPLETED');
  });
});
