/**
 * DELETE /api/auth/account
 *
 * Permanently deletes the authenticated user's account:
 *  1. Firestore profile document (/users/{uid})
 *  2. All raw reports submitted by the user (/rawReports where reporterId == uid)
 *  3. Firebase Auth record (via Admin SDK)
 *
 * The client still calls deleteUser() after this to clear the local Firebase
 * session, but the Admin SDK deletion here is the authoritative one.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('account-delete');
const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, prefix: 'account-delete' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

export async function DELETE(request: NextRequest): Promise<NextResponse<ApiResponse<null>>> {
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

  try {
    const { adminFirestore, adminAuth } = await import('@/lib/firebase/admin');

    // 1. Delete all raw reports by this user (batched)
    const reportsSnap = await adminFirestore
      .collection(COLLECTIONS.RAW_REPORTS)
      .where('reporterId', '==', uid)
      .get();

    if (!reportsSnap.empty) {
      const batches: import('firebase-admin/firestore').WriteBatch[] = [];
      let batch = adminFirestore.batch();
      let count = 0;
      for (const doc of reportsSnap.docs) {
        batch.delete(doc.ref);
        count++;
        if (count === 400) {
          batches.push(batch);
          batch = adminFirestore.batch();
          count = 0;
        }
      }
      if (count > 0) batches.push(batch);
      await Promise.all(batches.map((b) => b.commit()));
    }

    // 2. Delete Firestore profile
    await adminFirestore.collection(COLLECTIONS.USERS).doc(uid).delete();

    // 3. Delete Firebase Auth record
    await adminAuth.deleteUser(uid);

    logger.info('DELETE', 'account deleted', { uid }, ctx);

    return NextResponse.json(
      { success: true, data: null, error: null, requestId },
      {
        status: 200,
        headers: {
          // Clear the session cookie
          'Set-Cookie': [
            `${SESSION_COOKIE_NAME}=`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            'Max-Age=0',
          ].join('; '),
        },
      },
    );
  } catch (err) {
    logger.error('DELETE', 'account deletion failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to delete account.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
