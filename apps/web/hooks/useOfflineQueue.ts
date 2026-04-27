'use client';

/**
 * useOfflineQueue — manages the IndexedDB queue of pending need reports.
 *
 * When the device is offline the report form calls `enqueue()` instead of
 * posting directly to /api/needs.  This hook:
 *
 *  1. Reads the pending count from IndexedDB on mount and every 5 seconds.
 *  2. Listens for the browser `online` event and immediately attempts to
 *     drain the queue.
 *  3. Retries each report up to MAX_RETRIES times with exponential backoff
 *     (1 s, 2 s, 4 s).  After MAX_RETRIES failures the report is left in the
 *     queue so the user can manually retry later.
 *  4. On success, fires `onReportSynced(reportId)` so the UI can show a
 *     toast notification.
 *
 * The hook is deliberately lightweight — it never blocks the UI thread.
 * All IDB access happens in async functions that don't gate rendering.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PendingReport } from '@/lib/utils/indexeddb';
import type { NeedType } from '@rahatnet/types';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of a pending report that the form needs to enqueue. */
export interface QueueableReport {
  id: string;
  type: NeedType;
  description: string;
  originalDescription: string;
  originalLanguage: string;
  voiceNoteUrl: string | null;
  photoUrls: string[];
  location: { lat: number; lng: number };
  locationName: string;
  affectedCount: number;
  hasVulnerable: boolean;
  disasterEventId: string;
}

export interface UseOfflineQueueReturn {
  /** Number of reports waiting to be sent. */
  pendingCount: number;
  /** Whether a sync is currently in progress. */
  isSyncing: boolean;
  /** Enqueue a report for later submission. */
  enqueue: (report: QueueableReport) => Promise<void>;
  /** Manually trigger a sync attempt. */
  syncNow: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOfflineQueue(
  onReportSynced?: (reportId: string) => void,
): UseOfflineQueueReturn {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const syncingRef = useRef(false); // guard against concurrent syncs

  // ---- Load pending count ----
  const refreshCount = useCallback(async () => {
    try {
      const { getPendingReports } = await import('@/lib/utils/indexeddb');
      const reports = await getPendingReports();
      setPendingCount(reports.length);
    } catch {
      // IDB might not be available yet — silently ignore.
    }
  }, []);

  // ---- Attempt to drain the queue ----
  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setIsSyncing(true);

    try {
      const { getPendingReports, deletePendingReport, incrementRetryCount } =
        await import('@/lib/utils/indexeddb');
      const reports: PendingReport[] = await getPendingReports();

      for (const report of reports) {
        if (report.retryCount >= MAX_RETRIES) continue;

        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, report.retryCount);

        try {
          const res = await fetch('/api/needs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: report.type,
              description: report.description,
              originalDescription: report.originalDescription,
              originalLanguage: report.originalLanguage,
              voiceNoteUrl: report.voiceNoteUrl,
              photoUrls: report.photoUrls,
              location: report.location,
              locationName: report.locationName,
              affectedCount: report.affectedCount,
              hasVulnerable: report.hasVulnerable,
              disasterEventId: report.disasterEventId,
            }),
          });

          if (res.ok || (res.status >= 400 && res.status < 500)) {
            // Success or unrecoverable client error — remove from queue.
            await deletePendingReport(report.id);
            if (res.ok) {
              onReportSynced?.(report.id);
            }
          } else {
            // 5xx — server error, increment retry count and back off.
            await incrementRetryCount(report.id);
            await sleep(backoffMs);
          }
        } catch {
          // Network error — increment retry and continue to next report.
          await incrementRetryCount(report.id);
          await sleep(backoffMs);
        }
      }
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      await refreshCount();
    }
  }, [onReportSynced, refreshCount]);

  // ---- Enqueue a report ----
  const enqueue = useCallback(
    async (report: QueueableReport): Promise<void> => {
      const { savePendingReport } = await import('@/lib/utils/indexeddb');
      await savePendingReport(report);
      await refreshCount();
    },
    [refreshCount],
  );

  // ---- Poll count + listen for online events ----
  useEffect(() => {
    void refreshCount();
    const interval = setInterval(() => void refreshCount(), 5_000);

    const handleOnline = () => {
      void syncNow();
    };
    window.addEventListener('online', handleOnline);

    // Attempt an immediate sync on mount in case we just came online.
    if (navigator.onLine) void syncNow();

    return () => {
      clearInterval(interval);
      window.removeEventListener('online', handleOnline);
    };
  }, [refreshCount, syncNow]);

  return { pendingCount, isSyncing, enqueue, syncNow };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
