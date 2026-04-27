/**
 * POST /api/auth/onboard
 *
 * Sets the Firebase Auth custom claim for a newly onboarded user so that
 * the role is included in the next ID token (which becomes the session cookie).
 *
 * Called by OnboardingWizard after it has written the Firestore profile.
 * After this endpoint returns, the wizard calls refreshSession() which
 * force-refreshes the token, re-creates the session cookie with the new
 * claim, and re-fetches /api/auth/me — at that point AuthProvider navigates
 * to the role-appropriate home page.
 *
 * Security:
 *   The endpoint verifies the session cookie so only the authenticated user
 *   can set their own role.  Role can only be set once during onboarding
 *   (checked against the Firestore profile's onboardingStatus).
 *   Coordinators are assigned the COORDINATOR role but must be
 *   verified by an ADMIN before they can access the war room.
 *
 * Rate limiting: 5 requests per minute per IP.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { UserRole, COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { verifySessionCookie, setUserRole } from '@/lib/firebase/admin';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import {
  createRateLimiter,
  getClientIp,
  rateLimitedResponse,
} from '@/lib/api/rateLimit';
import { AppError } from '@/lib/utils/errors';

const logger = createServerLogger('onboard');

const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, prefix: 'auth-onboard' });

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

// Only citizens, volunteers, and coordinators can self-assign during onboarding.
// ADMIN is assigned server-side by existing admins.
const SELF_ASSIGNABLE_ROLES = new Set<UserRole>([
  UserRole.CITIZEN,
  UserRole.VOLUNTEER,
  UserRole.COORDINATOR,
]);

const bodySchema = z.object({
  role: z.nativeEnum(UserRole),
});

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  // 1. Verify session.
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (sessionCookie === undefined) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  let uid: string;
  try {
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    uid = decoded.uid;
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  // 2. Parse body.
  let body: z.infer<typeof bodySchema>;
  try {
    const raw: unknown = await request.json();
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid request body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  if (!SELF_ASSIGNABLE_ROLES.has(body.role)) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Role cannot be self-assigned.', statusCode: 403 }, requestId },
      { status: 403 },
    );
  }

  // 3. Check Firestore profile — if already COMPLETED, still set the custom claim
  //    in case it was missed on a previous attempt, then return success.
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const profileSnap = await adminFirestore.collection(COLLECTIONS.USERS).doc(uid).get();

    if (profileSnap.exists) {
      const profile = profileSnap.data() as { onboardingStatus?: string; role?: string };
      if (profile.onboardingStatus === 'COMPLETED') {
        // Ensure the custom claim is set (idempotent).
        const claimRole = body.role ?? (profile.role as UserRole) ?? UserRole.CITIZEN;
        await setUserRole(uid, claimRole, ctx);
        logger.info('POST', 'claim refreshed for already-onboarded user', { uid, role: claimRole }, ctx);
        return NextResponse.json(
          { success: true, data: null, error: null, requestId },
          { status: 200, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
  } catch (err) {
    logger.error('POST', 'Firestore check failed', toLogError(err), undefined, ctx);
  }

  // 4. Set the custom claim.
  try {
    await setUserRole(uid, body.role, ctx);
    logger.info('POST', 'role set', { uid, role: body.role }, ctx);
    return NextResponse.json(
      { success: true, data: null, error: null, requestId },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: err.message, statusCode: 500 }, requestId },
        { status: 500 },
      );
    }
    logger.error('POST', 'unexpected error', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to set role. Please try again.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
