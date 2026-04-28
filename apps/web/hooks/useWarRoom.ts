'use client';

/**
 * useWarRoom — central data hook for the war-room dashboard.
 *
 * Manages three live data streams:
 *
 *   1. Firestore /needs — full CanonicalNeed documents for the active disaster.
 *      Subscribes via `subscribeToDocuments` with a Firestore query filtered by
 *      disasterEventId and ordered by urgencyScore descending.
 *
 *   2. RTDB /volunteerLocations — live GPS positions of available volunteers.
 *      Updated every 30 s by the volunteer app; the war-room map renders pins.
 *
 *   3. RTDB /disasterAlerts — IMD activation alerts.
 *      Drives the DisasterAlert banner at the top of the page.
 *
 *   4. Firestore /disasterEvents/{id} — the active disaster event document.
 *      Loaded once on mount; refreshed when the ID changes.
 *
 * All subscriptions are cleaned up when the component unmounts.
 * The hook never throws — errors are captured in the returned `error` field.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  NeedStatus,
  NeedSeverity,
  COLLECTIONS,
  type CanonicalNeed,
  type RawReport,
  type RealtimeVolunteerLocation,
  type RealtimeDisasterAlert,
  type DisasterEvent,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WarRoomStats {
  total: number;
  critical: number;
  urgent: number;
  resolved: number;
  activeVolunteers: number;
  /** Unprocessed survey raw reports pending on the map. */
  surveyCount: number;
}

export interface UseWarRoomReturn {
  needs: CanonicalNeed[];
  /** Unprocessed survey raw reports — shown on map immediately before AI pipeline runs. */
  surveyReports: RawReport[];
  volunteerLocations: Readonly<Record<string, RealtimeVolunteerLocation>>;
  disasterAlerts: Readonly<Record<string, RealtimeDisasterAlert>>;
  activeDisaster: DisasterEvent | null;
  stats: WarRoomStats;
  isLoading: boolean;
  error: string | null;
  /** Call to manually refresh the needs list (e.g. after an assignment). */
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWarRoom(disasterEventId: string): UseWarRoomReturn {
  const [needs, setNeeds] = useState<CanonicalNeed[]>([]);
  const [surveyReports, setSurveyReports] = useState<RawReport[]>([]);
  const [volunteerLocations, setVolunteerLocations] = useState<
    Readonly<Record<string, RealtimeVolunteerLocation>>
  >({});
  const [disasterAlerts, setDisasterAlerts] = useState<
    Readonly<Record<string, RealtimeDisasterAlert>>
  >({});
  const [activeDisaster, setActiveDisaster] = useState<DisasterEvent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Keep track of whether this is the first load so we can clear the
  // skeleton after the initial Firestore snapshot arrives.
  const initialLoadDoneRef = useRef(false);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  // ── Firestore needs subscription ─────────────────────────────────────────
  useEffect(() => {
    if (!disasterEventId) return;

    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        // Use simple equality filter to avoid composite index requirement.
        // Filter out cancelled/duplicate client-side.
        unsub = subscribeToDocuments<CanonicalNeed>(
          COLLECTIONS.NEEDS,
          (docs) => {
            const filtered = docs
              .filter((n) => n.status !== NeedStatus.CANCELLED && n.status !== NeedStatus.DUPLICATE)
              .sort((a, b) => (b.urgencyScore ?? 0) - (a.urgencyScore ?? 0));
            setNeeds(filtered);
            if (!initialLoadDoneRef.current) {
              initialLoadDoneRef.current = true;
              setIsLoading(false);
            }
          },
          undefined,
          where('disasterEventId', '==', disasterEventId),
          limit(200),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load needs');
        setIsLoading(false);
      }
    })();

    return () => unsub?.();
  }, [disasterEventId, refreshTick]);

  // ── Survey raw reports (shown on map before AI pipeline runs) ────────────
  useEffect(() => {
    if (!disasterEventId) return;
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        unsub = subscribeToDocuments<RawReport>(
          COLLECTIONS.RAW_REPORTS,
          (docs) => {
            setSurveyReports(docs.filter((r) => r.source === 'SURVEY' && r.status === 'PENDING'));
          },
          undefined,
          where('disasterEventId', '==', disasterEventId),
          where('source', '==', 'SURVEY'),
          orderBy('createdAt', 'desc'),
          limit(100),
        );
      } catch {
        // Non-fatal — map still shows processed canonical needs
      }
    })();

    return () => unsub?.();
  }, [disasterEventId]);

  // ── RTDB volunteer locations ──────────────────────────────────────────────
  useEffect(() => {
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToVolunteerLocations } = await import('@/lib/firebase/realtime');
        unsub = subscribeToVolunteerLocations((locs) => setVolunteerLocations(locs));
      } catch {
        // Non-fatal — war room still works without volunteer locations
      }
    })();

    return () => unsub?.();
  }, []);

  // ── RTDB disaster alerts ──────────────────────────────────────────────────
  useEffect(() => {
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDisasterAlerts } = await import('@/lib/firebase/realtime');
        unsub = subscribeToDisasterAlerts((alerts) => setDisasterAlerts(alerts));
      } catch {
        // Non-fatal
      }
    })();

    return () => unsub?.();
  }, []);

  // ── Disaster event document ───────────────────────────────────────────────
  useEffect(() => {
    if (!disasterEventId) return;

    void (async () => {
      try {
        const { getDocument } = await import('@/lib/firebase/firestore');
        const event = await getDocument<DisasterEvent>(
          COLLECTIONS.DISASTER_EVENTS,
          disasterEventId,
        );
        setActiveDisaster(event);
      } catch {
        // Non-fatal — header can show fallback text
      }
    })();
  }, [disasterEventId]);

  // ── Derived stats (memo-like, but computed synchronously from state) ──────
  const activeNeeds = needs.filter(
    (n) => n.status !== NeedStatus.RESOLVED && n.status !== NeedStatus.CANCELLED,
  );
  const stats: WarRoomStats = {
    total: needs.length,
    critical: activeNeeds.filter((n) => n.severity === NeedSeverity.CRITICAL).length,
    urgent: activeNeeds.filter((n) => n.severity === NeedSeverity.URGENT).length,
    resolved: needs.filter((n) => n.status === NeedStatus.RESOLVED).length,
    activeVolunteers: Object.values(volunteerLocations).filter((v) => v.isAvailable).length,
    surveyCount: surveyReports.length,
  };

  return {
    needs,
    surveyReports,
    volunteerLocations,
    disasterAlerts,
    activeDisaster,
    stats,
    isLoading,
    error,
    refresh,
  };
}
