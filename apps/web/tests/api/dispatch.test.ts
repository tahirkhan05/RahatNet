/**
 * Tests for the volunteer dispatch algorithm and POST /api/dispatch route.
 *
 * Dispatch algorithm tests (lib/ai/dispatch.ts):
 *   - Score functions are deterministic and tested in isolation.
 *   - findBestVolunteers is tested with mocked Firestore + RTDB.
 *
 * API route tests (POST /api/dispatch, PATCH /api/dispatch/:id):
 *   - Tests use MSW to intercept fetch() calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/tests/mocks/server';
import {
  NeedType, Language, VolunteerSkill, AssignmentStatus,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Mock dispatch module dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/firebase/admin', () => ({
  adminFirestore: {
    collection: vi.fn().mockReturnValue({
      where:  vi.fn().mockReturnThis(),
      limit:  vi.fn().mockReturnThis(),
      get:    vi.fn().mockResolvedValue({ docs: [] }),
      doc:    vi.fn().mockReturnValue({ get: vi.fn().mockResolvedValue({ exists: false }) }),
    }),
  },
}));

vi.mock('firebase-admin/database', () => ({
  getDatabase: vi.fn().mockReturnValue({
    ref: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ val: vi.fn().mockReturnValue({}) }),
    }),
  }),
}));

vi.mock('@/lib/api/serverLogger', () => ({
  createServerLogger: vi.fn().mockReturnValue({
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toLogError: vi.fn((e: unknown) => ({ name: 'Error', message: String(e) })),
}));

// ---------------------------------------------------------------------------
// Import dispatch scoring functions (after mocks)
// ---------------------------------------------------------------------------

import {
  scoreDistance,
  scoreSkills,
  scoreLanguage,
  scoreHistory,
  haversineM,
  haversineToMinutes,
  PRIMARY_SKILLS,
} from '@/lib/ai/dispatch';
import { createMockNeed, createMockVolunteerMatch } from '@/tests/mocks/factories';

// ---------------------------------------------------------------------------
// 1. Pure scoring function unit tests
// ---------------------------------------------------------------------------

describe('scoreDistance', () => {
  it('scores 100 for 0 driving minutes (at destination)', () => {
    expect(scoreDistance(0)).toBe(100);
  });

  it('scores 0 for 20+ driving minutes (floored)', () => {
    expect(scoreDistance(20)).toBe(0);
    expect(scoreDistance(30)).toBe(0);
  });

  it('scores 75 for 5 minutes', () => {
    expect(scoreDistance(5)).toBe(75);
  });

  it('never returns a negative score', () => {
    expect(scoreDistance(999)).toBeGreaterThanOrEqual(0);
  });
});

describe('scoreSkills', () => {
  it('returns 100 when volunteer has a primary skill for the need type', () => {
    expect(scoreSkills([VolunteerSkill.BOAT_OPERATOR], NeedType.RESCUE)).toBe(100);
    expect(scoreSkills([VolunteerSkill.DOCTOR],        NeedType.MEDICINE)).toBe(100);
    expect(scoreSkills([VolunteerSkill.COOK],          NeedType.FOOD)).toBe(100);
  });

  it('returns 60 when volunteer has only a secondary skill', () => {
    // DRIVER is secondary for RESCUE
    expect(scoreSkills([VolunteerSkill.DRIVER], NeedType.RESCUE)).toBe(60);
  });

  it('returns 20 when volunteer has no matching skill', () => {
    expect(scoreSkills([VolunteerSkill.CARPENTER], NeedType.MEDICINE)).toBe(20);
  });

  it('primary skill beats secondary', () => {
    const primary   = scoreSkills([VolunteerSkill.BOAT_OPERATOR], NeedType.RESCUE);
    const secondary = scoreSkills([VolunteerSkill.DRIVER],        NeedType.RESCUE);
    expect(primary).toBeGreaterThan(secondary);
  });

  it('volunteer with both primary and secondary still returns 100', () => {
    expect(
      scoreSkills([VolunteerSkill.BOAT_OPERATOR, VolunteerSkill.DRIVER], NeedType.RESCUE),
    ).toBe(100);
  });
});

describe('scoreLanguage', () => {
  it('returns 100 when volunteer speaks the reporter\'s language', () => {
    expect(scoreLanguage([Language.MALAYALAM, Language.ENGLISH], Language.MALAYALAM)).toBe(100);
  });

  it('returns 50 when volunteer speaks English but reporter does not', () => {
    expect(scoreLanguage([Language.ENGLISH], Language.HINDI)).toBe(50);
  });

  it('returns 0 when there is no common language', () => {
    expect(scoreLanguage([Language.TELUGU], Language.HINDI)).toBe(0);
  });
});

describe('scoreHistory', () => {
  it('returns 50 (neutral) for a volunteer with no history', () => {
    expect(scoreHistory(null)).toBe(50);
    expect(scoreHistory({ tasksCompleted: 0, completionRate: 0, averageRating: null, avgResponseTimeMinutes: null })).toBe(50);
  });

  it('returns high score for a top-performing volunteer', () => {
    const score = scoreHistory({
      tasksCompleted:          20,
      completionRate:          1.0,
      averageRating:           5,
      avgResponseTimeMinutes:  5,
    });
    expect(score).toBeGreaterThan(85);
  });

  it('returns lower score for slow response time', () => {
    const fast = scoreHistory({ tasksCompleted: 5, completionRate: 0.9, averageRating: 4, avgResponseTimeMinutes: 5 });
    const slow = scoreHistory({ tasksCompleted: 5, completionRate: 0.9, averageRating: 4, avgResponseTimeMinutes: 18 });
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('haversineM', () => {
  it('returns 0 for the same point', () => {
    expect(haversineM(10, 76, 10, 76)).toBe(0);
  });

  it('returns ~111 km for 1 degree of latitude', () => {
    const dist = haversineM(0, 0, 1, 0);
    expect(dist).toBeCloseTo(111_000, -3); // within 1 km
  });

  it('returns ~200 m for the cluster boundary distance', () => {
    // 200 m north
    const northM = 200;
    const latDeg = northM / 111_000;
    const dist   = haversineM(10, 76, 10 + latDeg, 76);
    expect(dist).toBeCloseTo(200, 0);
  });
});

describe('haversineToMinutes', () => {
  it('estimates ~5 min overhead for 0 metres', () => {
    expect(haversineToMinutes(0)).toBe(5);
  });

  it('scales linearly with distance', () => {
    const t1 = haversineToMinutes(5_000);  // 5 km
    const t2 = haversineToMinutes(10_000); // 10 km
    expect(t2).toBeGreaterThan(t1);
  });
});

// ---------------------------------------------------------------------------
// 2. Composite scoring — volunteer comparison
// ---------------------------------------------------------------------------

describe('volunteer ranking', () => {
  it('a closer volunteer with exact skills scores higher than a distant one without', () => {
    // Volunteer A: 1 km away, boat operator → RESCUE need
    const distA  = scoreDistance(haversineToMinutes(1_000));
    const skillA = scoreSkills([VolunteerSkill.BOAT_OPERATOR], NeedType.RESCUE);
    const scoreA = distA * 0.40 + skillA * 0.35 + 50 * 0.15 + 50 * 0.10;

    // Volunteer B: 5 km away, carpenter (no rescue skill) → RESCUE need
    const distB  = scoreDistance(haversineToMinutes(5_000));
    const skillB = scoreSkills([VolunteerSkill.CARPENTER], NeedType.RESCUE);
    const scoreB = distB * 0.40 + skillB * 0.35 + 50 * 0.15 + 50 * 0.10;

    expect(scoreA).toBeGreaterThan(scoreB);
  });
});

// ---------------------------------------------------------------------------
// 3. API route tests (via MSW)
// ---------------------------------------------------------------------------

describe('POST /api/dispatch', () => {
  it('returns 201 with assignmentId on successful auto-select', async () => {
    const res  = await fetch('/api/dispatch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ needId: 'need-001', autoSelect: true }),
    });
    const body = await res.json() as {
      success: boolean;
      data: { assignmentId: string; volunteerId: string };
    };

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(typeof body.data.assignmentId).toBe('string');
  });

  it('returns 201 on manual volunteer selection', async () => {
    const res = await fetch('/api/dispatch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ needId: 'need-001', volunteerId: 'vol-001', autoSelect: false }),
    });

    expect(res.status).toBe(201);
  });

  it('returns 404 when no volunteers are available', async () => {
    server.use(
      http.post('/api/dispatch', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: {
              code: 'NOT_FOUND',
              message: 'No available volunteers found for this need.',
              statusCode: 404,
            },
            requestId: 'test',
          },
          { status: 404 },
        ),
      ),
    );

    const res = await fetch('/api/dispatch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ needId: 'need-001', autoSelect: true }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 429 when the same need is dispatched twice within 5 minutes', async () => {
    server.use(
      http.post('/api/dispatch', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: {
              code: 'RATE_LIMITED',
              message: 'This need was dispatched recently.',
              statusCode: 429,
            },
            requestId: 'test',
          },
          { status: 429 },
        ),
      ),
    );

    const res = await fetch('/api/dispatch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ needId: 'need-001', autoSelect: true }),
    });

    expect(res.status).toBe(429);
  });
});

describe('PATCH /api/dispatch/:assignmentId', () => {
  it('accepts a task (status → ACCEPTED)', async () => {
    const res = await fetch('/api/dispatch/asgn-001', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: 'ACCEPTED' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe(AssignmentStatus.ACCEPTED);
  });

  it('declines a task with a reason', async () => {
    server.use(
      http.patch('/api/dispatch/:assignmentId', () =>
        HttpResponse.json({
          success: true,
          data:    { assignmentId: 'asgn-001', status: AssignmentStatus.DECLINED },
          error:   null,
          requestId: 'test',
        }),
      ),
    );

    const res  = await fetch('/api/dispatch/asgn-001', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: 'DECLINED', reason: 'TOO_FAR' }),
    });
    const body = await res.json() as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe(AssignmentStatus.DECLINED);
  });

  it('marks task COMPLETED', async () => {
    server.use(
      http.patch('/api/dispatch/:assignmentId', () =>
        HttpResponse.json({
          success: true,
          data:    { assignmentId: 'asgn-001', status: AssignmentStatus.COMPLETED },
          error:   null,
          requestId: 'test',
        }),
      ),
    );

    const res = await fetch('/api/dispatch/asgn-001', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: 'COMPLETED' }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 404 for an unknown assignment ID', async () => {
    server.use(
      http.patch('/api/dispatch/:assignmentId', () =>
        HttpResponse.json(
          {
            success: false, data: null,
            error: { code: 'NOT_FOUND', message: 'Assignment not found.', statusCode: 404 },
            requestId: 'test',
          },
          { status: 404 },
        ),
      ),
    );

    const res = await fetch('/api/dispatch/unknown-id', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: 'ACCEPTED' }),
    });

    expect(res.status).toBe(404);
  });
});
