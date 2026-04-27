/**
 * GET /api/dispatch/matches/:needId — return the top volunteer matches for a need
 * Used by the war-room AssignVolunteerModal to show ranked candidates.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, CanonicalNeed } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';
import type { VolunteerMatch } from '@/lib/ai/dispatch';

const logger  = createServerLogger('dispatch-matches');
const limiter  = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: 'dispatch-matches' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

export async function GET(
  request: NextRequest,
  { params }: { params: { needId: string } },
): Promise<NextResponse<ApiResponse<VolunteerMatch[]>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    const role = decoded['role'] as string | undefined;
    if (role !== 'COORDINATOR' && role !== 'ADMIN') {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Coordinator role required.', statusCode: 403 }, requestId },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const needSnap = await adminFirestore.collection(COLLECTIONS.NEEDS).doc(params.needId).get();

    if (!needSnap.exists) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'NOT_FOUND' as const, message: 'Need not found.', statusCode: 404 }, requestId },
        { status: 404 },
      );
    }

    const need = { id: needSnap.id, ...needSnap.data() } as CanonicalNeed;
    const count = parseInt(new URL(request.url).searchParams.get('count') ?? '3', 10);

    const { findBestVolunteers } = await import('@/lib/ai/dispatch');
    const matches = await findBestVolunteers(need, Math.min(count, 10), ctx);

    logger.info('GET', 'matches returned', { needId: params.needId, matchCount: matches.length }, ctx);
    return NextResponse.json({ success: true, data: matches, error: null, requestId });
  } catch (err) {
    logger.error('GET', 'match fetch failed', toLogError(err), { needId: params.needId }, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to compute matches.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
