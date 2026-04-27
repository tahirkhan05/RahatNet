'use client';

/**
 * QueryProvider sets up TanStack Query v5 with production-sensible defaults:
 *
 * - staleTime 60 s  → most data remains fresh for a minute without refetching
 * - gcTime 5 min    → evict unused cache entries after 5 minutes of inactivity
 * - retry 2          → tolerate transient network errors
 * - refetchOnWindowFocus true → war-room dashboard stays live when user tabs back
 *
 * The DevTools panel is rendered only in development so the production bundle
 * ships zero Devtools code (it's already tree-shaken, but the explicit check
 * makes intent clear).
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1_000,
        gcTime: 5 * 60 * 1_000,
        retry: 2,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: 1,
      },
    },
  });
}

/**
 * Singleton for the browser context.  We intentionally do NOT create a
 * module-level singleton so that each Next.js server render gets a fresh
 * client (required to avoid cross-request data contamination in SSR).
 */
let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // Server: always create a new client
    return makeQueryClient();
  }

  // Browser: reuse the existing client across re-renders
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  /**
   * NOTE: Avoid useState here.  If the component suspends during the initial
   * render, React will throw away the state and create a new QueryClient on
   * the retry — using the module-level getter avoids this.
   */
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
