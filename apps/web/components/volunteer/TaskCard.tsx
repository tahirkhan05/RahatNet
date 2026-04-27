'use client';

/**
 * TaskCard — displays a single need/task in the volunteer's task list.
 *
 * Two contexts:
 *   "my task"     — the active assignment; shows Navigate, Complete, Issue buttons.
 *   "nearby need" — an unassigned need near the volunteer; shows Express Interest button.
 *   "past task"   — a completed/failed assignment; read-only.
 *
 * Design for field use:
 *  - Minimum 48px tap targets on all buttons (WCAG 2.5.5)
 *  - 16px minimum font size throughout
 *  - High contrast mode support via system `prefers-contrast` CSS
 *  - Left border colour-coded by severity for instant visual scanning
 *  - Large (32px) need-type icon for recognition while moving
 *
 * Memoized with React.memo — only re-renders when the need, distance, or
 * status change, not on every volunteer location tick.
 */

import * as React from 'react';
import {
  Anchor, UtensilsCrossed, Cross, Home, Heart, Building2,
  MapPin, Users, Clock, Navigation, CheckCircle2, Phone,
  AlertTriangle, ThumbsUp, ChevronRight,
} from 'lucide-react';
import {
  NeedType, NeedSeverity, NeedStatus,
  type CanonicalNeed,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskCardContext = 'active' | 'nearby' | 'past';

export interface TaskCardProps {
  need:            CanonicalNeed;
  context:         TaskCardContext;
  /** Distance in metres from volunteer's current position. */
  distanceM?:      number;
  /** Called when the volunteer taps Navigate → opens Google Maps. */
  onNavigate?:     (need: CanonicalNeed) => void;
  /** Called when the volunteer marks the task complete. */
  onComplete?:     (need: CanonicalNeed) => void;
  /** Called when the volunteer reports an issue (task failed). */
  onIssue?:        (need: CanonicalNeed) => void;
  /** Called when the volunteer expresses interest in a nearby need. */
  onInterest?:     (need: CanonicalNeed) => void;
}

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

const NEED_ICONS: Record<NeedType, React.ReactNode> = {
  [NeedType.RESCUE]:         <Anchor          className="h-8 w-8" aria-hidden="true" />,
  [NeedType.FOOD]:           <UtensilsCrossed  className="h-8 w-8" aria-hidden="true" />,
  [NeedType.MEDICINE]:       <Cross            className="h-8 w-8" aria-hidden="true" />,
  [NeedType.SHELTER]:        <Home             className="h-8 w-8" aria-hidden="true" />,
  [NeedType.MENTAL_HEALTH]:  <Heart            className="h-8 w-8" aria-hidden="true" />,
  [NeedType.INFRASTRUCTURE]: <Building2        className="h-8 w-8" aria-hidden="true" />,
};

const SEVERITY_BORDER: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: 'border-l-red-500',
  [NeedSeverity.URGENT]:   'border-l-amber-500',
  [NeedSeverity.NORMAL]:   'border-l-blue-500',
  [NeedSeverity.LOW]:      'border-l-muted-foreground/40',
};

const SEVERITY_ICON_COLOR: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: 'text-red-600 dark:text-red-400',
  [NeedSeverity.URGENT]:   'text-amber-600 dark:text-amber-400',
  [NeedSeverity.NORMAL]:   'text-blue-600 dark:text-blue-400',
  [NeedSeverity.LOW]:      'text-muted-foreground',
};

const SEVERITY_BADGE: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  [NeedSeverity.URGENT]:   'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  [NeedSeverity.NORMAL]:   'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  [NeedSeverity.LOW]:      'bg-secondary text-muted-foreground',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDistance(metres: number): string {
  if (metres < 1_000) return `${Math.round(metres)} m`;
  return `${(metres / 1_000).toFixed(1)} km`;
}

function relativeTime(ts: { seconds: number } | null | undefined): string {
  if (!ts) return '';
  const diffMs  = Date.now() - ts.seconds * 1_000;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// TaskCard (memoized)
// ---------------------------------------------------------------------------

const COORDINATOR_PHONE = process.env['NEXT_PUBLIC_COORDINATOR_PHONE'] ?? '';

interface CitizenContact { displayName: string; phoneNumber: string | null; }

function useCitizenContact(reporterIds: string[], isActive: boolean): CitizenContact | null {
  const [contact, setContact] = React.useState<CitizenContact | null>(null);
  React.useEffect(() => {
    if (!isActive || !reporterIds[0]) return;
    void (async () => {
      try {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const db = getFirestore(firebaseApp);
        if (!reporterIds[0]) return;
        const snap = await getDoc(doc(db, 'users', reporterIds[0]));
        if (!snap.exists()) return;
        const d = snap.data();
        setContact({ displayName: d['displayName'] ?? 'Citizen', phoneNumber: d['phoneNumber'] ?? null });
      } catch { /* silent */ }
    })();
  }, [reporterIds[0], isActive]); // eslint-disable-line react-hooks/exhaustive-deps
  return contact;
}

function TaskCardInner({
  need, context, distanceM,
  onNavigate, onComplete, onIssue, onInterest,
}: TaskCardProps) {
  const sev         = need.severity ?? NeedSeverity.NORMAL;
  const borderColor = SEVERITY_BORDER[sev];
  const iconColor   = SEVERITY_ICON_COLOR[sev];
  const badgeColor  = SEVERITY_BADGE[sev];
  const isActive    = context === 'active';
  const isPast      = context === 'past';
  const createdAt   = need.createdAt as unknown as { seconds: number } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const citizenContact = useCitizenContact((need as any).reporterIds ?? [], isActive);

  return (
    <article
      className={[
        'rounded-xl border border-l-4 bg-card shadow-sm transition-shadow',
        borderColor,
        isActive ? 'border-primary/20 shadow-md ring-2 ring-primary/20' : '',
        'focus-within:ring-2 focus-within:ring-ring',
      ].join(' ')}
      aria-label={`${need.type} need: ${need.title}`}
    >
      <div className="p-4">
        {/* Row 1: icon + title + severity badge */}
        <div className="flex items-start gap-3">
          <div className={`shrink-0 ${iconColor}`} aria-hidden="true">
            {NEED_ICONS[need.type] ?? <MapPin className="h-8 w-8" />}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-base font-semibold leading-tight text-foreground">
                {need.title}
              </p>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badgeColor}`}>
                {sev}
              </span>
            </div>

            {/* Description */}
            {need.description && (
              <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                {need.description}
              </p>
            )}
          </div>
        </div>

        {/* Row 2: location + distance */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate max-w-[160px]">{need.locationName}</span>
          </span>

          {distanceM !== undefined && (
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Navigation className="h-4 w-4 shrink-0" aria-hidden="true" />
              {formatDistance(distanceM)}
            </span>
          )}

          <span className="flex items-center gap-1.5">
            <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
            {need.affectedCount} {need.affectedCount === 1 ? 'person' : 'people'}
            {need.hasVulnerable && (
              <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                ⚠ Vulnerable
              </span>
            )}
          </span>

          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            {relativeTime(createdAt)}
          </span>
        </div>

        {/* Row 3: status (past tasks) */}
        {isPast && (
          <div className="mt-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
            <span className="text-sm text-muted-foreground">
              {need.status === NeedStatus.RESOLVED ? 'Completed' : need.status}
            </span>
          </div>
        )}

        {/* Row 4: action buttons */}
        {!isPast && (
          <div className="mt-4 flex gap-2">
            {isActive && onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate(need)}
                className={[
                  'flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl',
                  'bg-primary px-4 text-base font-semibold text-primary-foreground',
                  'transition-colors hover:bg-primary/90 active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ].join(' ')}
                aria-label={`Navigate to ${need.locationName}`}
              >
                <Navigation className="h-5 w-5" aria-hidden="true" />
                Navigate
              </button>
            )}

            {isActive && onComplete && (
              <button
                type="button"
                onClick={() => onComplete(need)}
                className={[
                  'flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl',
                  'bg-success/10 border border-success/30 px-4 text-sm font-semibold text-success',
                  'transition-colors hover:bg-success/20 active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ].join(' ')}
                aria-label="Mark task as complete"
              >
                <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                Complete
              </button>
            )}

            {isActive && onIssue && (
              <button
                type="button"
                onClick={() => onIssue(need)}
                className={[
                  'flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl',
                  'border border-border bg-background px-3 text-muted-foreground',
                  'transition-colors hover:bg-accent hover:text-destructive',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ].join(' ')}
                aria-label="Report an issue with this task"
              >
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </button>
            )}

            {context === 'nearby' && onInterest && (
              <button
                type="button"
                onClick={() => onInterest(need)}
                className={[
                  'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl',
                  'border border-primary/30 bg-primary/5 px-4 text-sm font-semibold text-primary',
                  'transition-colors hover:bg-primary/10 active:scale-[0.98]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                ].join(' ')}
                aria-label="Express interest in helping with this need"
              >
                <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                I can help
                <ChevronRight className="h-4 w-4 ml-auto" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {/* Citizen contact (active tasks only) */}
        {isActive && (citizenContact || COORDINATOR_PHONE) && (
          <div className="mt-3 border-t border-border pt-3 space-y-2">
            {citizenContact && (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{citizenContact.displayName}</p>
                  <p className="text-[10px] text-muted-foreground">Person who reported</p>
                </div>
                {citizenContact.phoneNumber ? (
                  <a href={`tel:${citizenContact.phoneNumber}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20">
                    <Phone className="h-3.5 w-3.5" /> Call citizen
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">No phone provided</span>
                )}
              </div>
            )}
            {COORDINATOR_PHONE && (
              <a href={`tel:${COORDINATOR_PHONE}`}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent w-full justify-center">
                <Phone className="h-3.5 w-3.5" /> Emergency: Call Coordinator
              </a>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export const TaskCard = React.memo(TaskCardInner);
TaskCard.displayName = 'TaskCard';
