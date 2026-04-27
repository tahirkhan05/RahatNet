/**
 * Edge middleware — runs on every request before rendering.
 *
 * Two jobs:
 *  1. Authentication gate  – redirect unauthenticated users to /login.
 *  2. Authorisation check  – verify the user's role matches the route.
 *  3. Request tracing      – stamp every response with x-request-id.
 *
 * The Firebase Admin SDK cannot run in the Next.js Edge Runtime (no Node
 * crypto, no service account).  Instead we:
 *   a. Check the session cookie exists (fast, no crypto).
 *   b. Decode the JWT payload (base64url, no signature verification).
 *   c. Read the `role` custom claim we write in POST /api/auth/session.
 *
 * Full signature verification happens in every API route handler via the
 * Admin SDK — the middleware check here is defence-in-depth UX only (to
 * redirect the browser quickly) and not a security boundary.
 *
 * Route permission matrix:
 *   /coordinator/*  → coordinator | admin
 *   /volunteer/*    → volunteer | coordinator | admin
 *   /citizen/*      → citizen | volunteer | coordinator | admin (any authed)
 *   /login          → public (redirect to home if already authed)
 *   /api/health     → public
 *   /api/auth/*     → public (used during the sign-in flow itself)
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { UserRole } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COOKIE =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

/** Routes that are fully public — no session required. */
const PUBLIC_PREFIXES = [
  '/login',
  '/verify',
  '/onboarding',
  '/api/health',
  '/api/auth',
  '/_next',
  '/static',
  '/icons',
  '/sw.js',
  '/manifest.json',
  '/favicon.ico',
  '/og-image.png',
] as const;

/**
 * Role requirements per route prefix.
 * The array lists every role that is ALLOWED on that route.
 * Checked in declaration order — first match wins.
 */
const ROLE_RULES: ReadonlyArray<{
  prefix: string;
  allowed: ReadonlyArray<UserRole>;
  /** Human-readable name for error messages. */
  label: string;
}> = [
  {
    prefix: '/coordinator',
    allowed: [UserRole.COORDINATOR, UserRole.ADMIN],
    label: 'coordinator',
  },
  {
    prefix: '/volunteer',
    allowed: [UserRole.VOLUNTEER, UserRole.COORDINATOR, UserRole.ADMIN],
    label: 'volunteer',
  },
  {
    prefix: '/citizen',
    // Any authenticated user may report needs.
    allowed: [UserRole.CITIZEN, UserRole.VOLUNTEER, UserRole.COORDINATOR, UserRole.ADMIN],
    label: 'citizen',
  },
];

/** Role → default home page redirect target. */
const ROLE_HOME: Record<UserRole, string> = {
  [UserRole.CITIZEN]: '/citizen',
  [UserRole.VOLUNTEER]: '/volunteer',
  [UserRole.COORDINATOR]: '/coordinator',
  [UserRole.ADMIN]: '/coordinator',
};

// ---------------------------------------------------------------------------
// JWT helpers (Edge-safe, no crypto)
// ---------------------------------------------------------------------------

interface JwtClaims {
  /** Firebase UID */
  sub?: string;
  /** Token expiry (Unix seconds) */
  exp?: number;
  /** Custom claim set by POST /api/auth/session → setUserRole() */
  role?: string;
}

/**
 * Decode the payload section of a JWT without signature verification.
 * Returns null on any parse failure so callers can treat a malformed
 * cookie the same as an absent one.
 */
function decodeJwtPayload(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Base64url decode — works in both Edge Runtime and Node.js
    const base64url = parts[1] as string;
    // Pad to multiple of 4 and convert base64url → base64
    const base64 = base64url
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(base64url.length + (4 - (base64url.length % 4)) % 4, '=');

    // Use Buffer (available in Next.js Edge Runtime via the web crypto polyfill)
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

/**
 * Check whether the decoded claims are still within their validity window.
 * Firebase session cookies have a 14-day expiry; we add a 60-second clock
 * skew buffer so we don't reject tokens that expired in the last minute.
 */
function isTokenExpired(claims: JwtClaims): boolean {
  if (claims.exp === undefined) return true;
  return claims.exp < Math.floor(Date.now() / 1_000) - 60;
}

/**
 * Map the raw `role` claim string to the typed UserRole enum.
 * Falls back to CITIZEN if the claim is missing or unrecognised so that
 * a corrupted token grants the least privilege rather than crashing.
 */
function parseRole(raw: string | undefined): UserRole {
  const validRoles = Object.values(UserRole) as string[];
  if (raw !== undefined && validRoles.includes(raw)) {
    return raw as UserRole;
  }
  return UserRole.CITIZEN;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function buildLoginRedirect(request: NextRequest, reason?: string): NextResponse {
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
  if (reason !== undefined) loginUrl.searchParams.set('reason', reason);
  return NextResponse.redirect(loginUrl);
}

function buildForbiddenRedirect(request: NextRequest, requiredLabel: string): NextResponse {
  // Redirect to the user's own home page with an informational query param.
  const cookie = request.cookies.get(SESSION_COOKIE);
  const claims = cookie !== undefined ? decodeJwtPayload(cookie.value) : null;
  const role = parseRole(claims?.role);
  const homeUrl = new URL(ROLE_HOME[role], request.url);
  homeUrl.searchParams.set('forbidden', requiredLabel);
  return NextResponse.redirect(homeUrl);
}

// ---------------------------------------------------------------------------
// Main middleware
// ---------------------------------------------------------------------------

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Stamp every response with a correlation ID for distributed tracing.
  const requestId = crypto.randomUUID();

  // ------------------------------------------------------------------
  // 1. Public paths — skip all checks
  // ------------------------------------------------------------------
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const response = NextResponse.next();
    response.headers.set('x-request-id', requestId);
    return response;
  }

  // ------------------------------------------------------------------
  // 2. Read and validate the session cookie
  // ------------------------------------------------------------------
  const sessionCookie = request.cookies.get(SESSION_COOKIE);

  if (sessionCookie === undefined) {
    // No cookie at all → send to login.
    return buildLoginRedirect(request);
  }

  const claims = decodeJwtPayload(sessionCookie.value);

  if (claims === null || isTokenExpired(claims)) {
    // Malformed or expired token — treat as unauthenticated.
    return buildLoginRedirect(request, 'session_expired');
  }

  // Role claim may be absent on the first request after onboarding (the claim
  // was just set server-side but the cookie was issued a moment before).
  // Fall back to CITIZEN which is the least-privileged role — the API routes
  // do their own full verification via Firebase Admin SDK.
  const userRole = parseRole(claims.role);

  // ------------------------------------------------------------------
  // 3. Redirect already-authenticated users away from /login
  // ------------------------------------------------------------------
  if (pathname === '/login' || pathname === '/verify') {
    const homeUrl = new URL(ROLE_HOME[userRole], request.url);
    return NextResponse.redirect(homeUrl);
  }

  // ------------------------------------------------------------------
  // 4. Role-based authorisation
  // ------------------------------------------------------------------
  for (const rule of ROLE_RULES) {
    if (pathname.startsWith(rule.prefix)) {
      if (!rule.allowed.includes(userRole)) {
        return buildForbiddenRedirect(request, rule.label);
      }
      // Role is sufficient — fall through to the response.
      break;
    }
  }

  // ------------------------------------------------------------------
  // 5. Authorised — pass through with tracing header
  // ------------------------------------------------------------------
  const response = NextResponse.next();
  response.headers.set('x-request-id', requestId);
  // Surface the resolved role so server components can read it from headers
  // without another Firestore round-trip.
  response.headers.set('x-user-role', userRole);
  response.headers.set('x-user-uid', claims.sub ?? '');
  return response;
}

// ---------------------------------------------------------------------------
// Matcher — keep middleware off static assets to avoid pointless overhead
// ---------------------------------------------------------------------------

export const config = {
  matcher: [
    /*
     * Match every path EXCEPT:
     *   - _next/static  (static chunks, immutable)
     *   - _next/image   (image optimisation API)
     *   - Files with extensions (images, fonts, etc.)
     *
     * The negative lookahead covers these exclusions in a single expression.
     */
    '/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|css|js|map)).*)',
  ],
};
