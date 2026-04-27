'use client';

/**
 * useOffline — reports network state and pending offline-queue depth.
 *
 * Three signals are combined:
 *
 *   1. `navigator.onLine`        — instant, unreliable (can be true even when
 *                                   the network is metered and firewalled).
 *
 *   2. Heartbeat fetch           — GET /api/health every 30 s with a 5 s
 *                                   timeout.  This is the ground truth for
 *                                   "can the app reach the server?"
 *
 *   3. `navigator.connection`    — Network Information API (Chrome/Android).
 *                                   effectiveType === '2g' | 'slow-2g' → slow.
 *
 * The hook also polls IndexedDB every 5 s for the pending-report count,
 * which drives the "N reports waiting" copy in OfflineBanner.
 *
 * React to SW messages:
 *   REPORT_SYNCED — dec pendingCount by 1 so the banner updates without
 *                    waiting for the next 5-second IDB poll.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Network Information API — not in lib.dom.d.ts as of TS 5.4 */
interface NetworkInformation extends EventTarget {
  readonly effectiveType?: '2g' | '3g' | '4g' | 'slow-2g';
  readonly downlink?: number;
  readonly rtt?: number;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface NavigatorWithConnection extends Navigator {
  readonly connection?: NetworkInformation;
  readonly mozConnection?: NetworkInformation;
  readonly webkitConnection?: NetworkInformation;
}

export interface OfflineState {
  /** True when the heartbeat can reach /api/health (or navigator.onLine as fallback). */
  readonly isOnline: boolean;
  /** True when the Network Information API reports 2G or slow-2G. */
  readonly isSlowConnection: boolean;
  /** Number of reports in the IndexedDB offline queue waiting to be sent. */
  readonly pendingCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnection(): NetworkInformation | undefined {
  const nav = navigator as NavigatorWithConnection;
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

function isSlowEffectiveType(conn: NetworkInformation | undefined): boolean {
  return (
    conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g'
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param heartbeatIntervalMs  How often to check /api/health.
 *                             Default 30 000 ms (30 s).
 * @param idbPollIntervalMs    How often to check IndexedDB pending count.
 *                             Default 5 000 ms (5 s).
 */
export function useOffline(
  heartbeatIntervalMs = 30_000,
  idbPollIntervalMs   = 5_000,
): OfflineState {
  // Initialise from navigator.onLine so the first render is correct on SSR-free pages.
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [isSlowConnection, setIsSlowConnection] = useState<boolean>(
    typeof navigator !== 'undefined' ? isSlowEffectiveType(getConnection()) : false,
  );
  const [pendingCount, setPendingCount] = useState<number>(0);

  // Guard: prevent stale heartbeat results from racing with a newer one.
  const heartbeatSeq = useRef<number>(0);

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  const runHeartbeat = useCallback(async (): Promise<void> => {
    const seq = ++heartbeatSeq.current;
    try {
      const controller = new AbortController();
      const timerId    = setTimeout(() => controller.abort(), 5_000);
      await fetch('/api/health', {
        method: 'HEAD',
        signal: controller.signal,
        // Bypass service-worker (health should always hit the network)
        cache:  'no-store',
      });
      clearTimeout(timerId);
      // Only update state if this heartbeat is still the latest.
      if (seq === heartbeatSeq.current) setIsOnline(true);
    } catch {
      if (seq === heartbeatSeq.current) setIsOnline(false);
    }
  }, []);

  // ── Network Information API ────────────────────────────────────────────────

  useEffect(() => {
    const conn = getConnection();
    if (conn === undefined) return;

    const handleChange = () => setIsSlowConnection(isSlowEffectiveType(conn));
    handleChange(); // Sync on mount.
    conn.addEventListener('change', handleChange);
    return () => conn.removeEventListener('change', handleChange);
  }, []);

  // ── Online / offline browser events ───────────────────────────────────────

  useEffect(() => {
    const handleOnline = () => {
      // Browser says we're online — verify immediately with a heartbeat.
      setIsOnline(true);
      void runHeartbeat();

      // Also tell the service worker to drain the offline queue.
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller !== null) {
        navigator.serviceWorker.controller.postMessage({ type: 'TRIGGER_SYNC' });
      }
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);

    // Kick off the first heartbeat immediately.
    void runHeartbeat();

    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [runHeartbeat]);

  // ── Periodic heartbeat ─────────────────────────────────────────────────────

  useEffect(() => {
    const id = setInterval(() => void runHeartbeat(), heartbeatIntervalMs);
    return () => clearInterval(id);
  }, [runHeartbeat, heartbeatIntervalMs]);

  // ── IndexedDB pending count poll ───────────────────────────────────────────

  const refreshPendingCount = useCallback(async (): Promise<void> => {
    try {
      const { getPendingReports } = await import('@/lib/utils/indexeddb');
      const reports = await getPendingReports();
      setPendingCount(reports.length);
    } catch {
      // IDB unavailable — leave count as-is.
    }
  }, []);

  useEffect(() => {
    void refreshPendingCount();
    const id = setInterval(() => void refreshPendingCount(), idbPollIntervalMs);
    return () => clearInterval(id);
  }, [refreshPendingCount, idbPollIntervalMs]);

  // ── SW message listener (REPORT_SYNCED) ────────────────────────────────────

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'REPORT_SYNCED') {
        // A report was successfully sent — decrement without waiting for the poll.
        setPendingCount((c) => Math.max(0, c - 1));
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () =>
      navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  return { isOnline, isSlowConnection, pendingCount };
}
