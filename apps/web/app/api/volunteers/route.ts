/**
 * GET /api/volunteers — list available volunteers, optionally filtered by district/skills
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, PaginatedResponse, VolunteerProfile } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('volunteers');
const limiter  = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'volunteers' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<PaginatedResponse<VolunteerProfile>>>> {
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
    await verifySessionCookie(sessionCookie.value, ctx);
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const district    = searchParams.get('district');
  const available   = searchParams.get('available');
  const pageSize    = Math.min(50, parseInt(searchParams.get('pageSize') ?? '20', 10));

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');

    let query = adminFirestore
      .collection(COLLECTIONS.USERS)
      .where('role', '==', 'VOLUNTEER')
      .limit(pageSize);

    if (district) query = query.where('district', '==', district);
    if (available === 'true') query = query.where('isAvailable', '==', true);

    const snap = await query.get();
    const items = snap.docs.map((d) => ({ uid: d.id, ...d.data() })) as VolunteerProfile[];

    return NextResponse.json({
      success: true,
      data: { items, total: items.length, page: 1, pageSize, hasMore: items.length === pageSize },
      error: null,
      requestId,
    });
  } catch (err) {
    logger.error('GET', 'volunteers fetch failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to fetch volunteers.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
