'use client';

/**
 * useAuth — the primary auth hook for all RahatNet components.
 *
 * Reads from the Zustand authStore (hydrated by AuthProvider) and exposes
 * a stable, typed interface so components never reach into the store directly.
 *
 * The hook is read-only: it does not attach Firebase listeners (that is
 * AuthProvider's job).  This ensures listener deduplication — one listener
 * per app, not one per component that calls useAuth().
 *
 * Functions returned:
 *   logout()          — signs out of Firebase + clears session cookie
 *   refreshSession()  — force-refreshes the ID token and re-fetches the
 *                        profile from /api/auth/me.  Call after role changes.
 */

import { useCallback } from 'react';
import { useAuthStore } from '@/store/authStore';
import { UserRole } from '@rahatnet/types';
import type { AnyUserProfile, UserProfile } from '@rahatnet/types';

const ROLE_HOME: Record<UserRole, string> = {
  [UserRole.CITIZEN]: '/citizen',
  [UserRole.VOLUNTEER]: '/volunteer',
  [UserRole.COORDINATOR]: '/coordinator',
  [UserRole.ADMIN]: '/coordinator',
};

export interface UseAuthReturn {
  /** Full Firestore profile, or null when unauthenticated / loading. */
  user: UserProfile | null;
  /** True while the initial auth state is being resolved. */
  isLoading: boolean;
  /** True once a valid session has been established. */
  isAuthenticated: boolean;
  /**
   * The user's application role.
   * Falls back to CITIZEN while unauthenticated so components never get undefined.
   */
  role: UserRole;
  /** Sign out of Firebase and clear the server-side session cookie. */
  logout: () => Promise<void>;
  /**
   * Force-refresh the Firebase ID token and re-fetch the Firestore profile.
   *
   * Use after:
   *  - onboarding completion (role is written to Firestore and custom claims)
   *  - coordinator promotes a volunteer (role changed server-side)
   *  - profile update (displayName, avatar, etc.)
   */
  refreshSession: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const { user, isLoading, isAuthenticated, setUser, setLoading, clearAuth } = useAuthStore();

  const role: UserRole = user?.role ?? UserRole.CITIZEN;

  const logout = useCallback(async (): Promise<void> => {
    try {
      const { signOut } = await import('@/lib/firebase/auth');
      await signOut();
    } catch {
      // Even if Firebase signOut fails, clear local state and the cookie.
    }
    clearAuth();
  }, [clearAuth]);

  const refreshSession = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const { getIdToken, setSessionCookie } = await import('@/lib/firebase/auth');

      // Force-refresh the token so the new custom claim is included.
      const freshToken = await getIdToken(true);
      await setSessionCookie(freshToken);

      // Re-fetch the Firestore profile which now has the updated role.
      const res = await fetch('/api/auth/me', {
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        clearAuth();
        return;
      }

      const json = (await res.json()) as { data: AnyUserProfile | null };
      if (json.data !== null) {
        const profile = json.data as UserProfile;
        setUser(profile);
      }
    } catch {
      // Soft failure — don't sign the user out, just stop loading.
      setLoading(false);
    }
  }, [setUser, setLoading, clearAuth]);

  return { user, isLoading, isAuthenticated, role, logout, refreshSession };
}
