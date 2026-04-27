/**
 * POST /api/auth/fcm-token — persist a new FCM registration token for the authenticated user
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('fcm-token');
const limiter  = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: 'fcm-token' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({ token: z.string().min(100).max(512) });

export async function POST(
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
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid token.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    await adminFirestore.collection(COLLECTIONS.USERS).doc(uid).update({
      fcmToken:  body.token,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info('POST', 'FCM token updated', { uid }, ctx);
    return NextResponse.json({ success: true, data: null, error: null, requestId });
  } catch (err) {
    logger.error('POST', 'FCM token update failed', { name: 'Error', message: String(err) }, undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to update token.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
