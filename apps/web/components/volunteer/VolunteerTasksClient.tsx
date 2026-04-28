'use client';

/**
 * VolunteerTasksClient — the full volunteer tasks screen.
 *
 * Layout:
 *   ┌─────────────────────────────────┐
 *   │  HEADER: name + status toggle   │
 *   │  + skill badges                 │
 *   ├─────────────────────────────────┤
 *   │  ACTIVE TASK (if any)           │
 *   │  highlighted card               │
 *   ├─────────────────────────────────┤
 *   │  NEARBY NEEDS (if no task)      │
 *   │  or status message              │
 *   ├─────────────────────────────────┤
 *   │  PAST TASKS (collapsible)       │
 *   └─────────────────────────────────┘
 *
 * Optimistic updates:
 *   - Toggling availability: local state flips immediately, PATCH fires async.
 *     On error, flipped back with an error toast.
 *   - Marking complete: need removed from active list immediately, re-added on error.
 *   - Express interest: button shows loading, confirmed toast on success.
 *
 * High contrast mode:
 *   Detected via `window.matchMedia('(prefers-contrast: more)')`.
 *   When true, borders are thickened and colour labels are shown with text, not
 *   just hue.  This is handled via a CSS class on the root element; we apply
 *   it to the component container here.
 */

import * as React from 'react';
import {
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  MapIcon,
  Zap,
  Battery,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  NeedStatus,
  NeedSeverity,
  COLLECTIONS,
  type CanonicalNeed,
  type VolunteerProfile,
} from '@rahatnet/types';
import { useAuth } from '@/hooks/useAuth';
import { useVolunteerLocation } from '@/hooks/useVolunteerLocation';
import { useTaskNotifications } from '@/hooks/useTaskNotifications';
import { useOffline } from '@/hooks/useOffline';
import { useVolunteerStore } from '@/store/volunteerStore';
import { TaskCard } from './TaskCard';
import { TaskAcceptModal } from './TaskAcceptModal';
import { NeedDetailSheet } from './NeedDetailSheet';

// ---------------------------------------------------------------------------
// Haversine (metres)
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

interface VolunteerData {
  activeAssignments: { id: string; need: CanonicalNeed }[];
  nearbyNeeds: CanonicalNeed[];
  pastNeeds: CanonicalNeed[];
  isLoading: boolean;
}

function useVolunteerData(
  uid: string,
  disasterEventId: string,
  volunteerLat: number | null,
  volunteerLng: number | null,
): VolunteerData {
  const [activeAssignments, setActiveAssignments] = React.useState<
    { id: string; need: CanonicalNeed }[]
  >([]);
  const [nearbyNeeds, setNearbyNeeds] = React.useState<CanonicalNeed[]>([]);
  const [pastNeeds, setPastNeeds] = React.useState<CanonicalNeed[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  // Subscribe to active assignment.
  React.useEffect(() => {
    if (!uid) return;
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        // Avoid status 'in' query to prevent composite index requirement.
        // Filter client-side instead.
        unsub = subscribeToDocuments<import('@rahatnet/types').Assignment>(
          COLLECTIONS.ASSIGNMENTS,
          (docs) => {
            const actives = docs.filter(
              (d) =>
                d.status === 'ACCEPTED' ||
                d.status === 'IN_PROGRESS' ||
                d.status === 'NOTIFIED' ||
                d.status === 'CREATED',
            );
            if (actives.length > 0) {
              void (async () => {
                const { getDocument } = await import('@/lib/firebase/firestore');
                const results = await Promise.all(
                  actives.map(async (a) => {
                    const need = await getDocument<CanonicalNeed>(COLLECTIONS.NEEDS, a.needId);
                    return need ? { id: a.id, need } : null;
                  }),
                );
                setActiveAssignments(
                  results.filter((r): r is { id: string; need: CanonicalNeed } => r !== null),
                );
              })();
            } else {
              setActiveAssignments([]);
            }
            setIsLoading(false);
          },
          undefined,
          where('volunteerId', '==', uid),
          limit(10),
        );
      } catch {
        setIsLoading(false);
      }
    })();

    return () => unsub?.();
  }, [uid]);

  // Subscribe to nearby needs (VERIFIED, sorted by urgency).
  React.useEffect(() => {
    if (!disasterEventId) return;
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        unsub = subscribeToDocuments<CanonicalNeed>(
          COLLECTIONS.NEEDS,
          (docs) => {
            // Sort by distance from volunteer.
            const sorted = [...docs].sort((a, b) => {
              if (volunteerLat === null || volunteerLng === null) return 0;
              const dA = haversineM(volunteerLat, volunteerLng, a.location.lat, a.location.lng);
              const dB = haversineM(volunteerLat, volunteerLng, b.location.lat, b.location.lng);
              return dA - dB;
            });
            setNearbyNeeds(sorted.slice(0, 10));
          },
          undefined,
          where('disasterEventId', '==', disasterEventId),
          where('status', '==', NeedStatus.VERIFIED),
          orderBy('urgencyScore', 'desc'),
          limit(20),
        );
      } catch {
        // Non-fatal
      }
    })();

    return () => unsub?.();
  }, [disasterEventId, volunteerLat, volunteerLng]);

  // Fetch past tasks (last 5 completed).
  React.useEffect(() => {
    if (!uid) return;
    void (async () => {
      try {
        const { getDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        const assignments = await getDocuments<import('@rahatnet/types').Assignment>(
          COLLECTIONS.ASSIGNMENTS,
          undefined,
          where('volunteerId', '==', uid),
          where('status', 'in', ['COMPLETED', 'FAILED']),
          orderBy('completedAt', 'desc'),
          limit(5),
        );

        const needIds = [...new Set(assignments.map((a) => a.needId))];
        if (needIds.length === 0) return;

        const { getDocument } = await import('@/lib/firebase/firestore');
        const needs = await Promise.all(
          needIds.map((id) => getDocument<CanonicalNeed>(COLLECTIONS.NEEDS, id)),
        );
        setPastNeeds(needs.filter((n): n is CanonicalNeed => n !== null));
      } catch {
        // Non-fatal
      }
    })();
  }, [uid]);

  return { activeAssignments, nearbyNeeds, pastNeeds, isLoading };
}

// ---------------------------------------------------------------------------
// Toast (lightweight)
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error';
}

function ToastList({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-6 left-4 right-4 z-50 space-y-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 rounded-2xl px-4 py-3 text-base font-medium shadow-lg',
            'animate-slide-in pointer-events-auto',
            t.type === 'success' ? 'bg-success text-white' : 'bg-destructive text-white',
          ].join(' ')}
        >
          {t.type === 'success' ? (
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const ACTIVE_DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'demo-disaster-001';

export function VolunteerTasksClient() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const { isOnline } = useOffline();

  // ── Availability — single source of truth: Zustand volunteerStore ─────────
  const volunteer = user as VolunteerProfile | null;
  const { isAvailable, setAvailability } = useVolunteerStore();
  const [togglingAvail] = React.useState(false);

  // Seed from Firestore on mount ONLY if the store has never been set this
  // session (isAvailable is still the default false AND Firestore says true).
  // This handles page refresh where store resets to false.
  React.useEffect(() => {
    if (!user?.uid) return;
    // Always read fresh from Firestore on mount to handle page refresh
    void (async () => {
      try {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const snap = await getDoc(doc(getFirestore(firebaseApp), 'users', user.uid));
        if (snap.exists()) {
          setAvailability(snap.data()['isAvailable'] === true);
        }
      } catch {
        /* silent */
      }
    })();
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Location ──────────────────────────────────────────────────────────────
  const location = useVolunteerLocation({
    uid: user?.uid ?? null,
    isAvailable,
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const addToast = React.useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4_000);
  }, []);

  const { pendingAssignment, clearPendingAssignment } = useTaskNotifications({
    uid: user?.uid ?? null,
    onToast: (msg) => addToast(msg, 'success'),
    onNavigate: (url) => router.push(url),
  });

  // ── Data ──────────────────────────────────────────────────────────────────
  const { activeAssignments, nearbyNeeds, pastNeeds, isLoading } = useVolunteerData(
    user?.uid ?? '',
    ACTIVE_DISASTER_ID,
    location.lat,
    location.lng,
  );

  const [pastExpanded, setPastExpanded] = React.useState(false);
  const [detailNeed, setDetailNeed] = React.useState<CanonicalNeed | null>(null);

  // ── High contrast detection ───────────────────────────────────────────────
  const [highContrast, setHighContrast] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-contrast: more)');
    setHighContrast(mq.matches);
    const handler = (e: MediaQueryListEvent) => setHighContrast(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Availability is controlled from the dashboard — no toggle here.

  // ── Task actions ──────────────────────────────────────────────────────────
  const handleNavigate = (need: CanonicalNeed, assignmentId: string) => {
    router.push(`/volunteer/navigate?needId=${need.id}&assignmentId=${assignmentId}`);
  };

  const handleComplete = async (_need: CanonicalNeed, assignmentId: string) => {
    try {
      const res = await fetch(`/api/dispatch/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
      if (!res.ok) throw new Error('Failed to mark complete');
      addToast('Task marked as complete!', 'success');
    } catch {
      addToast('Could not mark task complete. Try again.', 'error');
    }
  };

  const handleIssue = async (_need: CanonicalNeed, assignmentId: string) => {
    if (!confirm('Report this task as failed (access blocked, situation changed)?')) return;
    try {
      const res = await fetch(`/api/dispatch/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FAILED', declinedNote: 'Issue reported by volunteer' }),
      });
      if (!res.ok) throw new Error('Failed to report issue');
      addToast('Issue reported. Coordinator will reassign.', 'success');
    } catch {
      addToast('Could not report issue. Try again.', 'error');
    }
  };

  const handleInterest = async (need: CanonicalNeed) => {
    try {
      await fetch('/api/dispatch/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needId: need.id, volunteerId: user?.uid }),
      });
      addToast('Interest noted — coordinator will confirm assignment.', 'success');
    } catch {
      addToast('Could not register interest. Try again.', 'error');
    }
  };

  // ── Loading / auth gate ───────────────────────────────────────────────────
  if (authLoading || isLoading) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <Loader2 className="text-primary h-10 w-10 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  const distanceForAssignment = (need: CanonicalNeed) =>
    location.lat !== null && location.lng !== null
      ? haversineM(location.lat, location.lng, need.location.lat, need.location.lng)
      : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={['bg-background min-h-screen pb-24', highContrast ? 'hc' : ''].join(' ')}>
      {/* Header */}
      <header className="border-border bg-card sticky top-0 z-30 border-b px-4 py-3">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-lg font-bold">
              {volunteer?.displayName ?? 'Volunteer'}
            </p>
            {/* Skill badges */}
            {volunteer && 'skills' in volunteer && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(volunteer as VolunteerProfile).skills.slice(0, 3).map((s) => (
                  <span
                    key={s}
                    className="bg-secondary text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium"
                  >
                    {s.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Battery / GPS warnings */}
        <div className="mt-2 flex gap-2">
          {location.batteryLow && (
            <div className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
              <Battery className="h-3 w-3" aria-hidden="true" />
              Low battery — location updates paused
            </div>
          )}
          {location.error && (
            <div className="bg-destructive/10 text-destructive flex items-center gap-1 rounded-full px-2 py-0.5 text-xs">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              GPS unavailable
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="space-y-5 px-4 py-4">
        {/* ── Assigned tasks ── */}
        {activeAssignments.length > 0 ? (
          <section aria-label="Your assigned tasks">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-foreground text-base font-semibold">
                Assigned to you
                {activeAssignments.length > 1 && (
                  <span className="bg-primary/10 text-primary ml-2 rounded-full px-2 py-0.5 text-xs font-medium">
                    {activeAssignments.length}
                  </span>
                )}
              </h2>
              <button
                type="button"
                onClick={() => router.push('/volunteer/map')}
                className="bg-primary/10 text-primary flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-medium"
              >
                <MapIcon className="h-4 w-4" aria-hidden="true" />
                View map
              </button>
            </div>
            <div className="space-y-3">
              {activeAssignments.map(({ id: assignmentId, need }) => (
                <TaskCard
                  key={assignmentId}
                  need={need}
                  context="active"
                  distanceM={distanceForAssignment(need)}
                  onNavigate={(n) => handleNavigate(n, assignmentId)}
                  onComplete={(n) => handleComplete(n, assignmentId)}
                  onIssue={(n) => handleIssue(n, assignmentId)}
                />
              ))}
            </div>
          </section>
        ) : isAvailable ? (
          /* ── Available tasks (express interest) ── */
          <section aria-label="Available tasks">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-foreground text-base font-semibold">Available Tasks</h2>
              <span className="bg-secondary text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                {nearbyNeeds.length} found
              </span>
            </div>

            {nearbyNeeds.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Zap className="text-muted-foreground h-10 w-10" aria-hidden="true" />
                <p className="text-foreground text-base font-medium">No nearby needs right now</p>
                <p className="text-muted-foreground text-sm">
                  New tasks will appear here when you are assigned.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {nearbyNeeds.map((need) => {
                  const dist =
                    location.lat !== null && location.lng !== null
                      ? haversineM(location.lat, location.lng, need.location.lat, need.location.lng)
                      : undefined;
                  return (
                    <TaskCard
                      key={need.id}
                      need={need}
                      context="nearby"
                      distanceM={dist}
                      onInterest={handleInterest}
                      onViewDetail={(n) => setDetailNeed(n)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          /* ── Off-duty state ── */
          <section className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="bg-secondary rounded-full p-6">
              <XCircle className="text-muted-foreground h-12 w-12" aria-hidden="true" />
            </div>
            <div>
              <p className="text-foreground text-lg font-semibold">You are off duty</p>
              <p className="text-muted-foreground mt-1 text-base">
                Toggle to Available to start receiving task assignments.
              </p>
            </div>
          </section>
        )}

        {/* ── Past tasks ── */}
        {pastNeeds.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setPastExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full items-center justify-between rounded py-2 text-base font-semibold focus-visible:outline-none focus-visible:ring-1"
              aria-expanded={pastExpanded}
            >
              Past Tasks ({pastNeeds.length})
              {pastExpanded ? (
                <ChevronUp className="h-5 w-5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-5 w-5" aria-hidden="true" />
              )}
            </button>

            {pastExpanded && (
              <div className="mt-3 space-y-3">
                {pastNeeds.map((need) => (
                  <TaskCard key={need.id} need={need} context="past" />
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Task accept modal */}
      {pendingAssignment !== null && (
        <TaskAcceptModal
          assignmentId={pendingAssignment.assignmentId}
          need={pendingAssignment.need}
          message={pendingAssignment.message}
          distanceM={
            location.lat !== null && location.lng !== null
              ? haversineM(
                  location.lat,
                  location.lng,
                  pendingAssignment.need.location.lat,
                  pendingAssignment.need.location.lng,
                )
              : undefined
          }
          onAccepted={() => {
            clearPendingAssignment();
            addToast('Task accepted! Navigate to the location.', 'success');
          }}
          onDeclined={() => {
            clearPendingAssignment();
          }}
        />
      )}

      {/* Need detail sheet */}
      {detailNeed !== null && (
        <NeedDetailSheet
          need={detailNeed}
          distanceM={
            location.lat !== null && location.lng !== null
              ? haversineM(
                  location.lat,
                  location.lng,
                  detailNeed.location.lat,
                  detailNeed.location.lng,
                )
              : undefined
          }
          onClose={() => setDetailNeed(null)}
          onConfirm={async (need) => {
            await handleInterest(need);
            setDetailNeed(null);
          }}
        />
      )}

      {/* Toasts */}
      <ToastList toasts={toasts} dismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
