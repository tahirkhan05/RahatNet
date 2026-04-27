/**
 * PATCH /api/volunteers/availability — toggle a volunteer's availability status
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('volunteer-availability');
const limiter  = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'vol-avail' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({
  isAvailable:       z.boolean(),
  availabilityStatus: z.enum(['AVAILABLE', 'UNAVAILABLE', 'BUSY', 'OFFLINE']).optional(),
});

export async function PATCH(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<null>>> {
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
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    const availabilityStatus = body.availabilityStatus ?? (body.isAvailable ? 'AVAILABLE' : 'UNAVAILABLE');

    await adminFirestore.collection(COLLECTIONS.USERS).doc(uid).update({
      isAvailable:       body.isAvailable,
      availabilityStatus,
      updatedAt:         FieldValue.serverTimestamp(),
    });

    // Remove RTDB location entry when going unavailable.
    if (!body.isAvailable) {
      try {
        const { getDatabase } = await import('firebase-admin/database');
        await getDatabase().ref(`volunteerLocations/${uid}`).remove();
      } catch { /* non-fatal */ }
    }

    logger.info('PATCH', 'availability updated', { uid, isAvailable: body.isAvailable }, ctx);
    return NextResponse.json({ success: true, data: null, error: null, requestId });
  } catch (err) {
    logger.error('PATCH', 'update failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Update failed.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
