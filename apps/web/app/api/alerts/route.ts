/**
 * GET /api/alerts — fetch active disaster alerts for the current session
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import type { ApiResponse, IMDAlert } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('alerts');
const limiter  = createRateLimiter({ limit: 30, windowMs: 60_000, prefix: 'alerts' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<readonly IMDAlert[]>>> {
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

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { Timestamp } = await import('firebase-admin/firestore');

    // Return alerts valid in the last 24 hours.
    const since = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1_000);

    const snap = await adminFirestore
      .collection('imdAlerts')
      .where('validUntil', '>=', since)
      .where('colorCode', 'in', ['RED', 'ORANGE'])
      .orderBy('validUntil', 'desc')
      .limit(20)
      .get();

    const alerts = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as IMDAlert[];

    return NextResponse.json(
      { success: true, data: alerts, error: null, requestId },
      { headers: { 'Cache-Control': 'private, max-age=60' } },
    );
  } catch (err) {
    logger.error('GET', 'alerts fetch failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to fetch alerts.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
