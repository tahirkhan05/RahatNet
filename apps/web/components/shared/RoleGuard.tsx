'use client';

/**
 * RoleGuard — renders children only when the authenticated user has one of the required roles.
 * Shows a fallback (or redirects) otherwise.
 *
 * Usage:
 *   <RoleGuard roles={['COORDINATOR', 'ADMIN']}>
 *     <WarRoomDashboard />
 *   </RoleGuard>
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { UserRole } from '@rahatnet/types';
import { useAuth } from '@/hooks/useAuth';

interface RoleGuardProps {
  /** Roles allowed to view the children. */
  roles:       readonly UserRole[];
  children:    React.ReactNode;
  /** Rendered instead of redirecting when the user lacks the required role. */
  fallback?:   React.ReactNode;
  /** Where to redirect when the user lacks the role (default: '/'). */
  redirectTo?: string;
}

export function RoleGuard({
  roles,
  children,
  fallback,
  redirectTo = '/',
}: RoleGuardProps) {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, role } = useAuth();

  // Still resolving auth state — render nothing to avoid flash.
  if (isLoading) return null;

  // Not logged in at all.
  if (!isAuthenticated) {
    router.replace(`/login?redirect=${encodeURIComponent(typeof window !== 'undefined' ? window.location.pathname : '/')}`);
    return null;
  }

  // Logged in but wrong role.
  if (!roles.includes(role)) {
    if (fallback) return <>{fallback}</>;
    router.replace(redirectTo);
    return null;
  }

  return <>{children}</>;
}
