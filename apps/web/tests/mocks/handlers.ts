/**
 * MSW (Mock Service Worker) request handlers for all RahatNet API routes.
 *
 * These handlers intercept fetch() calls in tests and return controlled
 * responses so no real network requests are made.
 *
 * Handler names follow the pattern: METHOD /api/route
 *
 * Tests that need different behaviour for a specific case should use
 * `server.use(overrideHandler)` inside that test — MSW prepends the override
 * so it takes priority, and `server.resetHandlers()` in afterEach cleans it up.
 */

import { http, HttpResponse } from 'msw';
import { createMockNeed, createMockUser, createMockAssignment, createMockVolunteerMatch } from './factories';
import { NeedStatus, AssignmentStatus } from '@rahatnet/types';

const REQUEST_ID = 'test-request-id';

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

export const authHandlers = [
  http.post('/api/auth/session', () =>
    HttpResponse.json({
      success: true, data: null, error: null, requestId: REQUEST_ID,
    }),
  ),

  http.delete('/api/auth/session', () =>
    new HttpResponse(null, { status: 200 }),
  ),

  http.get('/api/auth/me', () =>
    HttpResponse.json({
      success: true,
      data: createMockUser(),
      error: null,
      requestId: REQUEST_ID,
    }),
  ),

  http.post('/api/auth/fcm-token', () =>
    HttpResponse.json({ success: true, data: null, error: null, requestId: REQUEST_ID }),
  ),

  http.post('/api/auth/onboard', () =>
    HttpResponse.json({ success: true, data: null, error: null, requestId: REQUEST_ID }),
  ),
];

// ---------------------------------------------------------------------------
// Needs routes
// ---------------------------------------------------------------------------

export const needsHandlers = [
  http.get('/api/health', () =>
    HttpResponse.json({
      success: true,
      data: { status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' },
      error: null,
      requestId: REQUEST_ID,
    }),
  ),

  http.post('/api/needs', () =>
    HttpResponse.json(
      { success: true, data: { reportId: 'test-report-id' }, error: null, requestId: REQUEST_ID },
      { status: 201 },
    ),
  ),

  http.get('/api/needs', () =>
    HttpResponse.json({
      success: true,
      data: { items: [createMockNeed()], total: 1, page: 1, pageSize: 20, hasMore: false },
      error: null,
      requestId: REQUEST_ID,
    }),
  ),
];

// ---------------------------------------------------------------------------
// Dispatch routes
// ---------------------------------------------------------------------------

export const dispatchHandlers = [
  http.post('/api/dispatch', () =>
    HttpResponse.json(
      {
        success: true,
        data: {
          assignmentId:            'asgn-001',
          volunteerId:             'vol-001',
          volunteerName:           'Test Volunteer',
          estimatedArrivalMinutes: 8,
        },
        error: null,
        requestId: REQUEST_ID,
      },
      { status: 201 },
    ),
  ),

  http.patch('/api/dispatch/:assignmentId', ({ params }) =>
    HttpResponse.json({
      success: true,
      data:    { assignmentId: params.assignmentId, status: AssignmentStatus.ACCEPTED },
      error:   null,
      requestId: REQUEST_ID,
    }),
  ),

  http.get('/api/dispatch/matches/:needId', () =>
    HttpResponse.json({
      success: true,
      data:    [createMockVolunteerMatch(), createMockVolunteerMatch(), createMockVolunteerMatch()],
      error:   null,
      requestId: REQUEST_ID,
    }),
  ),

  http.post('/api/dispatch/interest', () =>
    HttpResponse.json({ success: true, data: null, error: null, requestId: REQUEST_ID }),
  ),

  http.post('/api/alerts/dismiss', () =>
    new HttpResponse(null, { status: 200 }),
  ),
];

// ---------------------------------------------------------------------------
// Analytics route
// ---------------------------------------------------------------------------

export const analyticsHandlers = [
  http.get('/api/analytics', () =>
    HttpResponse.json({
      success: true,
      data: {
        responseTimes:   [],
        funnel:          [],
        heatmap:         Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
        typeBreakdown:   [],
        coveragePercent: 60,
        resolvedPercent: 40,
        totalNeeds:      20,
        computedAt:      new Date().toISOString(),
      },
      error: null,
      requestId: REQUEST_ID,
    }),
  ),
];

// ---------------------------------------------------------------------------
// Resources route
// ---------------------------------------------------------------------------

export const resourceHandlers = [
  http.get('/api/resources', () =>
    HttpResponse.json({
      success: true, data: { items: [], total: 0, page: 1, pageSize: 20, hasMore: false },
      error: null, requestId: REQUEST_ID,
    }),
  ),

  http.post('/api/resources', () =>
    HttpResponse.json(
      { success: true, data: { resourceId: 'res-001' }, error: null, requestId: REQUEST_ID },
      { status: 201 },
    ),
  ),
];

// ---------------------------------------------------------------------------
// Volunteer availability route
// ---------------------------------------------------------------------------

export const volunteerHandlers = [
  http.patch('/api/volunteers/availability', () =>
    HttpResponse.json({ success: true, data: null, error: null, requestId: REQUEST_ID }),
  ),

  http.get('/api/volunteers', () =>
    HttpResponse.json({
      success: true,
      data:    { items: [], total: 0, page: 1, pageSize: 20, hasMore: false },
      error:   null,
      requestId: REQUEST_ID,
    }),
  ),
];

// ---------------------------------------------------------------------------
// All handlers (default export used in setup.ts)
// ---------------------------------------------------------------------------

export const handlers = [
  ...authHandlers,
  ...needsHandlers,
  ...dispatchHandlers,
  ...analyticsHandlers,
  ...resourceHandlers,
  ...volunteerHandlers,
];
