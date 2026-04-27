/**
 * POST   /api/auth/session  — exchange a Firebase ID token for an HttpOnly session cookie
 * DELETE /api/auth/session  — revoke tokens and clear the session cookie
 *
 * Session cookie properties:
 *   HttpOnly    — inaccessible to JavaScript (mitigates XSS token theft)
 *   Secure      — only sent over HTTPS in production
 *   SameSite=Strict — prevents CSRF (cookie is never sent in cross-site requests)
 *   Path=/      — sent with every same-origin request
 *   MaxAge=14d  — matches Firebase's maximum session cookie lifetime
 *
 * Rate limiting: 10 requests per minute per IP address.
 * The POST endpoint is a higher-value target for brute-force than most routes
 * because a valid ID token + session cookie gives full auth.
 *
 * POST response includes the full UserProfile so the client can hydrate the
 * Zustand auth store without a second round-trip to GET /api/auth/me.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, UserProfile } from '@rahatnet/types';
import {
  verifySessionCookie,
  createSessionCookie,
  revokeRefreshTokens,
} from '@/lib/firebase/admin';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import {
  createRateLimiter,
  getClientIp,
  rateLimitedResponse,
} from '@/lib/api/rateLimit';
import { AppError } from '@/lib/utils/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

/**
 * 14 days in milliseconds — Firebase's maximum session cookie lifetime.
 * Changing this below 5 minutes or above 14 days will cause `createSessionCookie` to throw.
 */
const SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1_000;

const IS_PRODUCTION = process.env['NODE_ENV'] === 'production';

// ---------------------------------------------------------------------------
// Rate limiter (shared across POST and DELETE for this route)
// ---------------------------------------------------------------------------

const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: 'auth-session' });

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createServerLogger('session');

// ---------------------------------------------------------------------------
// Input validation schemas
// ---------------------------------------------------------------------------

/**
 * POST body schema — currently empty (the ID token comes from the Authorization
 * header, not the body).  The schema is retained as a Zod validator so that
 * any unexpected body fields are rejected, which prevents parameter-pollution
 * attacks on future body additions.
 */
const postBodySchema = z
  .object({})
  .strict()
  .optional();

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Set the session cookie options.
 * `maxAge: 0` causes the browser to delete the cookie immediately.
 */
function buildCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  } as const;
}

// ---------------------------------------------------------------------------
// POST — create session cookie
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<UserProfile | null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  // 1. Rate limiting.
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    logger.warn('POST', 'rate limit exceeded', undefined, { ip }, ctx);
    return rateLimitedResponse(rl, requestId);
  }

  logger.info('POST', 'received', { ip }, ctx);

  // 2. Extract and validate Authorization header.
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'AUTH_REQUIRED' as const,
          message: 'Missing or malformed Authorization header. Expected: Bearer <id_token>',
          statusCode: 401,
        },
        requestId,
      },
      { status: 401 },
    );
  }

  const idToken = authorization.slice(7).trim();
  if (idToken.length === 0) {
    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'MISSING_FIELD' as const,
          message: 'ID token is empty.',
          statusCode: 400,
        },
        requestId,
      },
      { status: 400 },
    );
  }

  // 3. Optionally validate request body (must be empty or absent).
  try {
    if (request.headers.get('content-length') !== '0' &&
        request.headers.get('content-type')?.includes('application/json')) {
      const body: unknown = await request.json().catch(() => ({}));
      const parsed = postBodySchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            success: false as const,
            data: null,
            error: {
              code: 'VALIDATION_ERROR' as const,
              message: 'Unexpected fields in request body.',
              details: parsed.error.flatten().fieldErrors,
              statusCode: 400,
            },
            requestId,
          },
          { status: 400 },
        );
      }
    }
  } catch {
    // JSON parse error — body is malformed, but we don't need the body for this route.
  }

  // 4. Verify the ID token and create a session cookie.
  try {
    const { adminAuth, adminFirestore } = await import('@/lib/firebase/admin');

    // Verify the token is genuine — also checks token is not expired.
    const decodedToken = await adminAuth.verifyIdToken(idToken, /* checkRevoked */ true);
    logger.info('POST', 'ID token verified', { uid: decodedToken.uid }, ctx);

    const sessionCookie = await createSessionCookie(idToken, SESSION_EXPIRY_MS, ctx);

    // 5. Set the HttpOnly cookie.
    const cookieStore = cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, buildCookieOptions(SESSION_EXPIRY_MS / 1_000));

    // 6. Fetch the Firestore profile to return in the response body.
    //    This saves the client a second round-trip to GET /api/auth/me.
    let profile: UserProfile | null = null;
    try {
      const profileSnap = await adminFirestore
        .collection(COLLECTIONS.USERS)
        .doc(decodedToken.uid)
        .get();

      if (profileSnap.exists) {
        profile = { uid: profileSnap.id, ...profileSnap.data() } as UserProfile;
      }
    } catch (profileErr) {
      // Profile fetch failure is non-fatal for session creation — the client can
      // call /api/auth/me separately.  Log and continue.
      logger.warn(
        'POST',
        'profile fetch failed — session created without profile',
        toLogError(profileErr),
        { uid: decodedToken.uid },
        ctx,
      );
    }

    logger.info('POST', 'session created', { uid: decodedToken.uid }, ctx);

    return NextResponse.json(
      { success: true as const, data: profile, error: null, requestId },
      {
        status: 200,
        headers: {
          // Surface the UID so the client can store it in-memory.
          'x-uid': decodedToken.uid,
          // Tell the browser not to cache this response.
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(
        {
          success: false as const,
          data: null,
          error: { code: err.code as 'INVALID_TOKEN', message: err.message, statusCode: 401 },
          requestId,
        },
        { status: 401 },
      );
    }

    logger.error('POST', 'unexpected error', toLogError(err), undefined, ctx);
    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'INVALID_TOKEN' as const,
          message: 'The sign-in token is invalid, expired, or has been revoked.',
          statusCode: 401,
        },
        requestId,
      },
      { status: 401 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — sign out, revoke tokens, clear cookie
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  // Rate limit sign-out too — prevents token-revocation DoS.
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    logger.warn('DELETE', 'rate limit exceeded', undefined, { ip }, ctx);
    return rateLimitedResponse(rl, requestId);
  }

  logger.info('DELETE', 'signing out', undefined, ctx);

  try {
    const cookieStore = cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

    if (sessionCookie !== undefined) {
      // Attempt revocation — swallowed on failure because clearing the cookie
      // is the primary goal and the cookie will expire naturally in 14 days.
      try {
        const decoded = await verifySessionCookie(sessionCookie.value, ctx);
        await revokeRefreshTokens(decoded.uid, ctx);
        logger.info('DELETE', 'tokens revoked', { uid: decoded.uid }, ctx);
      } catch (revokeErr) {
        logger.warn(
          'DELETE',
          'revocation failed — clearing cookie anyway',
          toLogError(revokeErr),
          undefined,
          ctx,
        );
      }

      // Delete the session cookie by setting maxAge to 0.
      cookieStore.set(SESSION_COOKIE_NAME, '', buildCookieOptions(0));
    } else {
      logger.info('DELETE', 'no session cookie present — nothing to revoke', undefined, ctx);
    }

    logger.info('DELETE', 'signed out', undefined, ctx);

    return NextResponse.json(
      { success: true as const, data: null, error: null, requestId },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (err) {
    logger.error('DELETE', 'unexpected error during sign-out', toLogError(err), undefined, ctx);
    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'INTERNAL_ERROR' as const,
          message: 'Sign-out encountered an error. Please try again.',
          statusCode: 500,
        },
        requestId,
      },
      { status: 500 },
    );
  }
}
