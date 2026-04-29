'use client';

/**
 * AuthProvider — single Firebase Auth listener for the entire app.
 *
 * Responsibilities:
 *  1. Initialise Firebase Auth SDK (lazy import — keeps SDK out of SSR bundle).
 *  2. Subscribe to onAuthStateChanged once; keep Zustand authStore in sync.
 *  3. On sign-in: exchange the ID token for an HttpOnly session cookie, then
 *     fetch the Firestore profile from GET /api/auth/me.
 *  4. On sign-out: clear local state (session cookie DELETE happens in signOut()).
 *  5. Redirect unauthenticated users away from protected routes.
 *  6. Render a full-page loading skeleton while the initial auth state is
 *     resolving so children never flash an unauthenticated state.
 *
 * Why a single provider rather than useAuth() in every component:
 *  - Exactly one Firebase listener per app lifecycle.
 *  - The skeleton prevents layout shifts on protected pages.
 *  - Children can safely call useAuth() without attaching duplicate listeners.
 */

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { UserRole } from '@rahatnet/types';
import type { AnyUserProfile, UserProfile } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Route configuration
// ---------------------------------------------------------------------------

/** Routes the auth provider redirects away from once authenticated. */
const PUBLIC_PATHS = new Set(['/login', '/verify', '/onboarding']);

/** Where each role lands after a successful sign-in. */
const ROLE_HOME: Record<UserRole, string> = {
  [UserRole.CITIZEN]: '/citizen',
  [UserRole.VOLUNTEER]: '/volunteer',
  [UserRole.COORDINATOR]: '/coordinator',
  [UserRole.ADMIN]: '/coordinator',
};

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

/**
 * Full-page skeleton shown while the Firebase Auth state is being resolved.
 * Matches the warm background from globals.css so there is no flash.
 */
function AuthLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your session"
      className="bg-background flex min-h-screen items-center justify-center"
    >
      <div className="flex flex-col items-center gap-4">
        {/* Animated logo mark */}
        <div className="bg-primary/20 skeleton-shimmer h-12 w-12 rounded-xl" />
        <div className="bg-muted skeleton-shimmer h-4 w-32 rounded" />
        <div className="bg-muted/60 skeleton-shimmer h-3 w-24 rounded" />
        <span className="sr-only">Loading your session…</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, setUser, setLoading, clearAuth, isLoading } = useAuthStore();

  // Track whether the Firebase SDK has been lazily imported.
  const [sdkReady, setSdkReady] = React.useState(false);
  // Track whether we have resolved the auth state at least once.
  const [resolved, setResolved] = React.useState(false);

  // ---- Step 1: lazy-import Firebase client SDK ----
  React.useEffect(() => {
    import('@/lib/firebase/client')
      .then(() => setSdkReady(true))
      .catch((err: unknown) => {
        console.error('[AuthProvider] Firebase SDK failed to load:', err);
        // Mark resolved so we don't block the app indefinitely.
        setResolved(true);
        setLoading(false);
      });
  }, [setLoading]);

  // ---- Step 2: subscribe to Auth state ----
  React.useEffect(() => {
    if (!sdkReady) return;

    setLoading(true);

    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const { onAuthStateChanged, getIdToken, setSessionCookie } =
        await import('@/lib/firebase/auth');

      unsubscribe = onAuthStateChanged(async (firebaseUser) => {
        if (firebaseUser === null) {
          clearAuth();
          setResolved(true);

          if (!PUBLIC_PATHS.has(pathname)) {
            const encoded = encodeURIComponent(pathname);
            router.replace(`/login?redirect=${encoded}`);
          }
          return;
        }

        try {
          // Exchange for a server-side session cookie.
          // Force-refresh so we always have a fresh token with the latest claims.
          const idToken = await getIdToken(true);
          await setSessionCookie(idToken);

          // Fetch the Firestore profile (includes role + all fields).
          const res = await fetch('/api/auth/me', {
            headers: { 'Cache-Control': 'no-cache' },
          });

          if (!res.ok) {
            // Invalid session or profile not found — send to onboarding or login.
            if (res.status === 404) {
              // Profile not found: new user who hasn't completed onboarding.
              setUser({
                uid: firebaseUser.uid,
                role: UserRole.CITIZEN,
                onboardingStatus: 'NOT_STARTED',
              } as unknown as UserProfile);
              setResolved(true);
              router.replace('/onboarding');
              return;
            }
            clearAuth();
            setResolved(true);
            return;
          }

          const json = (await res.json()) as { data: AnyUserProfile | null };

          if (json.data === null) {
            clearAuth();
            setResolved(true);
            return;
          }

          setUser(json.data as UserProfile);
          setResolved(true);

          // New users who haven't completed onboarding go there first.
          if (json.data.onboardingStatus === 'NOT_STARTED' && pathname !== '/onboarding') {
            router.replace('/onboarding');
            return;
          }

          // Redirect if the user is sitting on a public auth page (including /onboarding after completion).
          redirectAfterSignIn(json.data.role, pathname, router);
        } catch (err) {
          console.error('[AuthProvider] Session hydration failed:', err);
          setLoading(false);
          setResolved(true);
        }
      });
    })();

    return () => unsubscribe?.();
    // pathname deliberately excluded from deps — redirect once on mount, not on
    // every navigation. eslint-disable-next-line is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, setUser, setLoading, clearAuth, router]);

  // Reactive redirect: if auth has resolved and the user is authenticated but
  // still sitting on a public path (e.g. race between router.replace and render),
  // redirect them to their role home page.
  React.useEffect(() => {
    if (!resolved || !isAuthenticated || user == null) return;
    if (!PUBLIC_PATHS.has(pathname)) return;
    redirectAfterSignIn(user.role, pathname, router);
  }, [resolved, isAuthenticated, user, pathname, router]);

  // Show the skeleton until we know whether the user is signed in.
  // `isLoading` from the store is true until setUser/clearAuth is called.
  if (!resolved && isLoading) {
    return <AuthLoadingSkeleton />;
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redirectAfterSignIn(
  role: UserRole,
  currentPath: string,
  router: ReturnType<typeof useRouter>,
): void {
  // Don't redirect if already on a non-auth page (user navigated directly).
  if (!PUBLIC_PATHS.has(currentPath)) return;

  // Honour the ?redirect= query param set by middleware.
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const redirect = params.get('redirect');
  if (
    redirect !== null &&
    redirect.startsWith('/') &&
    !redirect.startsWith('//') &&
    redirect !== '/'
  ) {
    router.replace(redirect);
    return;
  }

  router.replace(ROLE_HOME[role] ?? '/citizen');
}
