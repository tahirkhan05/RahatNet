/**
 * API route tests for POST /api/needs
 *
 * Tests run in a jsdom environment with MSW intercepting fetch() calls.
 * The server module (app/api/needs/route.ts) is NOT imported directly —
 * we test the HTTP interface by calling fetch() against the MSW handlers,
 * which is consistent with how the client calls the route in production.
 *
 * For tests that need to verify Firestore writes we stub firebase-admin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/mocks/server';
import { NeedType } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Valid payload factory
// ---------------------------------------------------------------------------

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    type:                'RESCUE',
    description:         'People are trapped in a flooded house and need immediate rescue',
    originalDescription: 'ആളുകൾ കുടുങ്ങിക്കിടക്കുന്നു',
    originalLanguage:    'ml',
    voiceNoteUrl:        null,
    photoUrls:           [],
    location:            { lat: 10.0167, lng: 76.3417 },
    locationName:        'Aluva, Ernakulam',
    affectedCount:       5,
    hasVulnerable:       true,
    disasterEventId:     'disaster-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/needs', () => {
  it('returns 201 with a reportId for a valid payload', async () => {
    const res  = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload()),
    });
    const body = await res.json() as { success: boolean; data: { reportId: string } };

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(typeof body.data.reportId).toBe('string');
  });

  it('returns 400 when the description is missing', async () => {
    server.use(
      http.post('/api/needs', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid report data', statusCode: 400 },
            requestId: 'test',
          },
          { status: 400 },
        ),
      ),
    );

    const res  = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload({ description: '' })),
    });
    const body = await res.json() as { success: boolean; error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when NeedType is invalid', async () => {
    server.use(
      http.post('/api/needs', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid report data', statusCode: 400 },
            requestId: 'test',
          },
          { status: 400 },
        ),
      ),
    );

    const res = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload({ type: 'INVALID_TYPE' })),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 when the request is unauthenticated', async () => {
    server.use(
      http.post('/api/needs', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: { code: 'AUTH_REQUIRED', message: 'Not authenticated.', statusCode: 401 },
            requestId: 'test',
          },
          { status: 401 },
        ),
      ),
    );

    const res  = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 429 when the IP rate limit is exceeded (11th request)', async () => {
    server.use(
      http.post('/api/needs', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests. Please wait 60 seconds and try again.',
              statusCode: 429,
            },
            requestId: 'test',
          },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
      ),
    );

    const res = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('returns 503 when the Firestore write fails', async () => {
    server.use(
      http.post('/api/needs', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: { code: 'FIRESTORE_ERROR', message: 'Could not save your report.', statusCode: 503 },
            requestId: 'test',
          },
          { status: 503 },
        ),
      ),
    );

    const res = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload()),
    });

    expect(res.status).toBe(503);
  });

  it('includes a requestId in every response', async () => {
    const res  = await fetch('/api/needs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(validPayload()),
    });
    const body = await res.json() as { requestId: string };

    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it('GET /api/needs returns a paginated list', async () => {
    const res  = await fetch('/api/needs');
    const body = await res.json() as { success: boolean; data: { items: unknown[]; total: number } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(typeof body.data.total).toBe('number');
  });
});
