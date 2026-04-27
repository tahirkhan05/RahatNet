/**
 * POST /api/dispatch/interest
 *
 * Volunteer expresses interest in a need. Records the volunteer's UID
 * on the need document so the coordinator can see who is available to assign.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger = createServerLogger('dispatch-interest');
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'dispatch-interest' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({ needId: z.string().min(1) });

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<null>>> {
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

  let uid: string;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    uid = decoded.uid;
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'needId is required.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    const needRef = adminFirestore.collection(COLLECTIONS.NEEDS).doc(body.needId);
    const needSnap = await needRef.get();

    if (!needSnap.exists) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'NOT_FOUND' as const, message: 'Need not found.', statusCode: 404 }, requestId },
        { status: 404 },
      );
    }

    // Add volunteer to interestedVolunteerIds array (idempotent via arrayUnion)
    await needRef.update({
      interestedVolunteerIds: FieldValue.arrayUnion(uid),
      updatedAt: new Date(),
    });

    logger.info('POST', 'interest recorded', { needId: body.needId, uid }, ctx);

    return NextResponse.json(
      { success: true, data: null, error: null, requestId },
      { status: 200 },
    );
  } catch (err) {
    logger.error('POST', 'unexpected error', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to record interest.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
