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
  CheckCircle2, XCircle, ChevronDown, ChevronUp,
  Loader2, AlertCircle, MapIcon, Zap, Battery,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  NeedStatus, NeedSeverity, COLLECTIONS,
  type CanonicalNeed, type VolunteerProfile,
} from '@rahatnet/types';
import { useAuth }              from '@/hooks/useAuth';
import { useVolunteerLocation } from '@/hooks/useVolunteerLocation';
import { useTaskNotifications } from '@/hooks/useTaskNotifications';
import { useOffline }           from '@/hooks/useOffline';
import { useVolunteerStore }    from '@/store/volunteerStore';
import { TaskCard }             from './TaskCard';
import { TaskAcceptModal }      from './TaskAcceptModal';

// ---------------------------------------------------------------------------
// Haversine (metres)
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

interface VolunteerData {
  activeAssignment: { id: string; need: CanonicalNeed } | null;
  nearbyNeeds:      CanonicalNeed[];
  pastNeeds:        CanonicalNeed[];
  isLoading:        boolean;
}

function useVolunteerData(
  uid:            string,
  disasterEventId: string,
  volunteerLat:   number | null,
  volunteerLng:   number | null,
): VolunteerData {
  const [activeAssignment, setActiveAssignment] = React.useState<{ id: string; need: CanonicalNeed } | null>(null);
  const [nearbyNeeds,      setNearbyNeeds]      = React.useState<CanonicalNeed[]>([]);
  const [pastNeeds,        setPastNeeds]        = React.useState<CanonicalNeed[]>([]);
  const [isLoading,        setIsLoading]        = React.useState(true);

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
            const active = docs.find(
              (d) =>
                d.status === 'ACCEPTED' ||
                d.status === 'IN_PROGRESS' ||
                d.status === 'NOTIFIED' ||
                d.status === 'CREATED',
            );
            if (active) {
              void (async () => {
                const { getDocument } = await import('@/lib/firebase/firestore');
                const need = await getDocument<CanonicalNeed>(COLLECTIONS.NEEDS, active.needId);
                if (need) setActiveAssignment({ id: active.id, need });
              })();
            } else {
              setActiveAssignment(null);
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

  return { activeAssignment, nearbyNeeds, pastNeeds, isLoading };
}

// ---------------------------------------------------------------------------
// Toast (lightweight)
// ---------------------------------------------------------------------------

interface Toast { id: string; message: string; type: 'success' | 'error' }

function ToastList({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-6 left-4 right-4 z-50 space-y-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 rounded-2xl px-4 py-3 shadow-lg text-base font-medium',
            'pointer-events-auto animate-slide-in',
            t.type === 'success'
              ? 'bg-success text-white'
              : 'bg-destructive text-white',
          ].join(' ')}
        >
          {t.type === 'success'
            ? <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            : <AlertCircle  className="h-5 w-5 shrink-0" aria-hidden="true" />}
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
      } catch { /* silent */ }
    })();
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Location ──────────────────────────────────────────────────────────────
  const location = useVolunteerLocation({
    uid:         user?.uid ?? null,
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
    uid:        user?.uid ?? null,
    onToast:    (msg) => addToast(msg, 'success'),
    onNavigate: (url) => router.push(url),
  });

  // ── Data ──────────────────────────────────────────────────────────────────
  const {
    activeAssignment, nearbyNeeds, pastNeeds, isLoading,
  } = useVolunteerData(
    user?.uid ?? '',
    ACTIVE_DISASTER_ID,
    location.lat,
    location.lng,
  );

  const [pastExpanded, setPastExpanded] = React.useState(false);

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
  const handleNavigate = (need: CanonicalNeed) => {
    if (!activeAssignment) return;
    router.push(`/volunteer/navigate?needId=${need.id}&assignmentId=${activeAssignment.id}`);
  };

  const handleComplete = async (need: CanonicalNeed) => {
    if (!activeAssignment) return;
    try {
      const res = await fetch(`/api/dispatch/${activeAssignment.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'COMPLETED' }),
      });
      if (!res.ok) throw new Error('Failed to mark complete');
      addToast('Task marked as complete!', 'success');
    } catch {
      addToast('Could not mark task complete. Try again.', 'error');
    }
  };

  const handleIssue = async (need: CanonicalNeed) => {
    if (!activeAssignment) return;
    if (!confirm('Report this task as failed (access blocked, situation changed)?')) return;
    try {
      const res = await fetch(`/api/dispatch/${activeAssignment.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'FAILED', declinedNote: 'Issue reported by volunteer' }),
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
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ needId: need.id, volunteerId: user?.uid }),
      });
      addToast('Interest noted — coordinator will confirm assignment.', 'success');
    } catch {
      addToast('Could not register interest. Try again.', 'error');
    }
  };

  // ── Loading / auth gate ───────────────────────────────────────────────────
  if (authLoading || isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden="true" />
      </div>
    );
  }

  const distanceToActive =
    activeAssignment && location.lat !== null && location.lng !== null
      ? haversineM(location.lat, location.lng, activeAssignment.need.location.lat, activeAssignment.need.location.lng)
      : undefined;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className={[
        'min-h-screen bg-background pb-24',
        highContrast ? 'hc' : '',
      ].join(' ')}
    >
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold text-foreground truncate">
              {volunteer?.displayName ?? 'Volunteer'}
            </p>
            {/* Skill badges */}
            {volunteer && 'skills' in volunteer && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(volunteer as VolunteerProfile).skills.slice(0, 3).map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
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
            <div className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              GPS unavailable
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="px-4 py-4 space-y-5">

        {/* ── Assigned task ── */}
        {activeAssignment !== null ? (
          <section aria-label="Your assigned task">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-foreground">
                Assigned to you
              </h2>
              <button
                type="button"
                onClick={() => router.push('/volunteer/map')}
                className="flex items-center gap-1.5 rounded-xl bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
              >
                <MapIcon className="h-4 w-4" aria-hidden="true" />
                View map
              </button>
            </div>
            <TaskCard
              need={activeAssignment.need}
              context="active"
              distanceM={distanceToActive}
              onNavigate={handleNavigate}
              onComplete={handleComplete}
              onIssue={handleIssue}
            />
          </section>
        ) : isAvailable ? (
          /* ── Available tasks (express interest) ── */
          <section aria-label="Available tasks">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-foreground">Available Tasks</h2>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                {nearbyNeeds.length} found
              </span>
            </div>

            {nearbyNeeds.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Zap className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
                <p className="text-base font-medium text-foreground">No nearby needs right now</p>
                <p className="text-sm text-muted-foreground">
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
                    />
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          /* ── Off-duty state ── */
          <section className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="rounded-full bg-secondary p-6">
              <XCircle className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <p className="text-lg font-semibold text-foreground">You are off duty</p>
              <p className="mt-1 text-base text-muted-foreground">
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
              className="flex w-full items-center justify-between py-2 text-base font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
              aria-expanded={pastExpanded}
            >
              Past Tasks ({pastNeeds.length})
              {pastExpanded
                ? <ChevronUp   className="h-5 w-5" aria-hidden="true" />
                : <ChevronDown className="h-5 w-5" aria-hidden="true" />}
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
                  location.lat, location.lng,
                  pendingAssignment.need.location.lat, pendingAssignment.need.location.lng,
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

      {/* Toasts */}
      <ToastList toasts={toasts} dismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
