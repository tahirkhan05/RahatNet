/**
 * GET /api/auth/me
 *
 * Returns the fully hydrated UserProfile for the authenticated request.
 *
 * Data sources (in order of authority):
 *  1. Session cookie    — verified cryptographically via Firebase Admin SDK
 *  2. Firestore profile — source of truth for all profile fields
 *  3. Decoded token claims — `role` custom claim used as fast-path fallback
 *     when the Firestore profile does not yet exist (e.g. during onboarding)
 *
 * The decoded token's custom claims (`role`, `skills`) are merged onto the
 * Firestore profile so the response always includes the latest role claim
 * even if the Firestore document was not yet updated after a role change.
 *
 * Caching:
 *   `Cache-Control: private, max-age=60` — browsers and the TanStack Query
 *   cache can serve the profile for up to 60 seconds without re-fetching.
 *   The query is invalidated explicitly after onboarding or profile updates.
 *
 * Rate limiting: 10 requests per minute per IP.
 *
 * Used by:
 *  - AuthProvider.tsx on every page load to hydrate the Zustand store.
 *  - Client components that need fresh profile data after an update.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { COLLECTIONS } from '@rahatnet/types';
import { UserRole } from '@rahatnet/types';
import type { ApiResponse, UserProfile, AnyUserProfile } from '@rahatnet/types';
import { verifySessionCookie } from '@/lib/firebase/admin';
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

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const limiter = createRateLimiter({ limit: 10, windowMs: 60_000, prefix: 'auth-me' });

const logger = createServerLogger('me');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that the `role` stored in the Firestore profile is a valid `UserRole`.
 * Falls back to `UserRole.CITIZEN` for legacy profiles or data corruption.
 */
function parseRole(raw: unknown): UserRole {
  const validRoles = Object.values(UserRole) as string[];
  if (typeof raw === 'string' && validRoles.includes(raw)) {
    return raw as UserRole;
  }
  return UserRole.CITIZEN;
}

/**
 * Merge the Firebase Auth custom claims onto the Firestore profile.
 *
 * Custom claims are the "fast-path" source for the middleware role check.
 * The Firestore profile is the source of truth — we use the claim value only
 * when the profile field is missing or stale (e.g. immediately after a
 * role upgrade before the client has refreshed).
 *
 * We intentionally do NOT blindly overwrite the profile role with the claim
 * because the claim might be from an older token that has not yet reflected
 * a coordinator-initiated demotion.
 */
function mergeClaimsIntoProfile(
  profile: UserProfile,
  claims: Record<string, unknown>,
): UserProfile {
  // If the profile already has a valid role, trust it.
  const profileRole = parseRole(profile.role);

  // If the claim has a different role, prefer the profile (Firestore is authoritative).
  // Surface the claim role only when the profile role is the default CITIZEN
  // and the claim carries something more specific — this covers the window
  // between a coordinator promoting a user and the Firestore write propagating.
  const effectiveRole =
    profileRole === UserRole.CITIZEN && claims['role'] != null
      ? parseRole(claims['role'])
      : profileRole;

  if (effectiveRole === profile.role) return profile;

  return { ...profile, role: effectiveRole };
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<AnyUserProfile>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  // 1. Rate limiting.
  const rl = limiter.check(ip);
  if (!rl.allowed) {
    logger.warn('GET', 'rate limit exceeded', undefined, { ip }, ctx);
    return rateLimitedResponse(rl, requestId) as NextResponse<ApiResponse<AnyUserProfile>>;
  }

  // 2. Read and validate the session cookie.
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

  if (sessionCookie === undefined) {
    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'AUTH_REQUIRED' as const,
          message: 'No active session. Please sign in.',
          statusCode: 401,
        },
        requestId,
      },
      { status: 401 },
    );
  }

  try {
    // 3. Cryptographic session cookie verification (also checks revocation).
    const decodedToken = await verifySessionCookie(sessionCookie.value, ctx);
    const uid = decodedToken.uid;
    logger.info('GET', 'session verified', { uid }, ctx);

    // 4. Fetch the Firestore profile.
    const { adminFirestore } = await import('@/lib/firebase/admin');

    const profileSnap = await adminFirestore.collection(COLLECTIONS.USERS).doc(uid).get();

    if (!profileSnap.exists) {
      // Profile does not exist yet — the user just signed up and onboarding
      // has not yet written to Firestore.  Return a minimal skeleton built
      // from the token claims so the client can complete onboarding.
      logger.info('GET', 'profile not found — returning token-based skeleton', { uid }, ctx);

      const tokenRole = parseRole(decodedToken['role']);

      // The skeleton satisfies UserProfile so AuthProvider can navigate to /onboarding.
      const skeleton: Partial<UserProfile> = {
        uid,
        phoneNumber: decodedToken.phone_number ?? null,
        email: decodedToken.email ?? null,
        displayName: decodedToken.name ?? '',
        photoURL: decodedToken.picture ?? null,
        role: tokenRole,
        onboardingStatus: 'NOT_STARTED',
        notificationPreferences: null,
        fcmToken: null,
        language: 'en' as UserProfile['language'],
        district: '',
        state: '',
      };

      return NextResponse.json(
        { success: true as const, data: skeleton as unknown as AnyUserProfile, error: null, requestId },
        {
          status: 200,
          headers: {
            // Don't cache the skeleton — the client should re-fetch after onboarding.
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    // 5. Merge custom claims onto the Firestore profile.
    const rawProfile = { uid: profileSnap.id, ...profileSnap.data() } as UserProfile;
    const profile = mergeClaimsIntoProfile(rawProfile, decodedToken as Record<string, unknown>);

    logger.info('GET', 'profile returned', { uid, role: profile.role }, ctx);

    return NextResponse.json(
      { success: true as const, data: profile as AnyUserProfile, error: null, requestId },
      {
        status: 200,
        headers: {
          // Short private cache — stale by at most 60 s after a role change.
          // Invalidated by the client after onboarding or profile updates.
          'Cache-Control': 'private, max-age=60, stale-while-revalidate=30',
        },
      },
    );
  } catch (err) {
    if (err instanceof AppError && err.code === 'AUTH_REQUIRED') {
      logger.warn('GET', 'invalid or revoked session', undefined, undefined, ctx);

      return NextResponse.json(
        {
          success: false as const,
          data: null,
          error: {
            code: 'SESSION_EXPIRED' as const,
            message: 'Your session has expired. Please sign in again.',
            statusCode: 401,
          },
          requestId,
        },
        {
          status: 401,
          headers: {
            // Delete the stale cookie so the browser stops sending it.
            'Set-Cookie': [
              `${SESSION_COOKIE_NAME}=`,
              'Path=/',
              'HttpOnly',
              'SameSite=Strict',
              'Max-Age=0',
              ...(process.env['NODE_ENV'] === 'production' ? ['Secure'] : []),
            ].join('; '),
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    logger.error('GET', 'unexpected error', toLogError(err), undefined, ctx);

    return NextResponse.json(
      {
        success: false as const,
        data: null,
        error: {
          code: 'INTERNAL_ERROR' as const,
          message: 'An unexpected error occurred. Please try again.',
          statusCode: 500,
        },
        requestId,
      },
      { status: 500 },
    );
  }
}
