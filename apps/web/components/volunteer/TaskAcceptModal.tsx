'use client';

/**
 * TaskAcceptModal — fullscreen overlay shown when a task is assigned.
 *
 * The volunteer has 60 seconds to respond before the assignment is auto-declined
 * (coordinator is waiting on a dispatch decision).
 *
 * Design decisions:
 *  - Full-screen so the notification is impossible to miss while driving / on a boat.
 *  - All interactive targets ≥ 60px (extra large, field use).
 *  - Haptic feedback on Accept via `navigator.vibrate([100, 50, 100])`.
 *  - Countdown progress bar + pulsing colour to communicate urgency.
 *  - Decline reason select so the dispatcher learns why volunteers decline.
 *  - Escape key closes with a DECLINED/TIMEOUT reason.
 *
 * On accept: PATCH /api/dispatch/:assignmentId {status: ACCEPTED} (optimistic).
 * On decline: PATCH /api/dispatch/:assignmentId {status: DECLINED, declinedReason}.
 * On timeout: same as decline with reason TIMEOUT.
 */

import * as React from 'react';
import {
  Anchor, UtensilsCrossed, Cross, Home, Heart, Building2,
  MapPin, Users, Phone, Clock, X, AlertTriangle, Loader2,
} from 'lucide-react';
import {
  NeedType, NeedSeverity, DeclineReason,
  type CanonicalNeed,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Props + config
// ---------------------------------------------------------------------------

interface TaskAcceptModalProps {
  assignmentId:   string;
  need:           CanonicalNeed;
  message:        string;
  /** Computed from volunteer's current location to need. 0 when unavailable. */
  distanceM?:     number;
  onAccepted:     () => void;
  onDeclined:     (reason: DeclineReason) => void;
}

const COUNTDOWN_SECONDS = 60;

const NEED_ICONS: Record<NeedType, React.ReactNode> = {
  [NeedType.RESCUE]:         <Anchor          className="h-12 w-12" aria-hidden="true" />,
  [NeedType.FOOD]:           <UtensilsCrossed  className="h-12 w-12" aria-hidden="true" />,
  [NeedType.MEDICINE]:       <Cross            className="h-12 w-12" aria-hidden="true" />,
  [NeedType.SHELTER]:        <Home             className="h-12 w-12" aria-hidden="true" />,
  [NeedType.MENTAL_HEALTH]:  <Heart            className="h-12 w-12" aria-hidden="true" />,
  [NeedType.INFRASTRUCTURE]: <Building2        className="h-12 w-12" aria-hidden="true" />,
};

const SEV_COLORS: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: 'text-red-500',
  [NeedSeverity.URGENT]:   'text-amber-500',
  [NeedSeverity.NORMAL]:   'text-blue-500',
  [NeedSeverity.LOW]:      'text-muted-foreground',
};

const SEV_BG: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: 'bg-red-50 dark:bg-red-950',
  [NeedSeverity.URGENT]:   'bg-amber-50 dark:bg-amber-950',
  [NeedSeverity.NORMAL]:   'bg-blue-50 dark:bg-blue-950',
  [NeedSeverity.LOW]:      'bg-secondary',
};

const DECLINE_REASONS: Array<{ value: DeclineReason; label: string }> = [
  { value: DeclineReason.TOO_FAR,          label: 'Too far away'          },
  { value: DeclineReason.NO_EQUIPMENT,     label: 'Missing equipment'     },
  { value: DeclineReason.ALREADY_ENGAGED,  label: 'Already helping someone' },
  { value: DeclineReason.HEALTH_ISSUE,     label: 'Unwell or injured'     },
  { value: DeclineReason.ACCESS_BLOCKED,   label: 'Route blocked'         },
  { value: DeclineReason.OTHER,            label: 'Other reason'          },
];

function formatDistance(metres: number | undefined): string {
  if (!metres) return '';
  if (metres < 1_000) return `${Math.round(metres)} m away`;
  return `${(metres / 1_000).toFixed(1)} km away`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TaskAcceptModal({
  assignmentId, need, message, distanceM,
  onAccepted, onDeclined,
}: TaskAcceptModalProps) {
  const [secondsLeft,    setSecondsLeft]    = React.useState(COUNTDOWN_SECONDS);
  const [showDecline,    setShowDecline]    = React.useState(false);
  const [declineReason,  setDeclineReason]  = React.useState<DeclineReason>(DeclineReason.TOO_FAR);
  const [submitting,     setSubmitting]     = React.useState(false);
  const [submitError,    setSubmitError]    = React.useState<string | null>(null);
  const timedOut = React.useRef(false);

  const sev      = need.severity ?? NeedSeverity.NORMAL;
  const iconCls  = SEV_COLORS[sev];
  const bgCls    = SEV_BG[sev];
  const pct      = (secondsLeft / COUNTDOWN_SECONDS) * 100;

  // ── Countdown ─────────────────────────────────────────────────────────────

  React.useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          if (!timedOut.current) {
            timedOut.current = true;
            void handleDecline(DeclineReason.TIMEOUT);
          }
          return 0;
        }
        return s - 1;
      });
    }, 1_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape key → decline.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        void handleDecline(DeclineReason.OTHER);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting]);

  // ── API calls ──────────────────────────────────────────────────────────────

  const handleAccept = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    // Haptic feedback (strong, success pattern).
    if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);

    try {
      const res = await fetch(`/api/dispatch/${assignmentId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'ACCEPTED' }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Failed to accept task');
      }
      onAccepted();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not accept task. Please try again.');
      setSubmitting(false);
    }
  };

  const handleDecline = async (reason: DeclineReason) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await fetch(`/api/dispatch/${assignmentId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'DECLINED', declinedReason: reason }),
      }).catch(() => undefined); // best-effort
    } finally {
      onDeclined(reason);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-modal-title"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      {/* Countdown progress bar */}
      <div className="h-1.5 w-full bg-secondary overflow-hidden">
        <div
          className={[
            'h-full transition-all duration-1000 ease-linear',
            secondsLeft > 20 ? 'bg-primary' : secondsLeft > 10 ? 'bg-amber-500' : 'bg-red-500 animate-pulse',
          ].join(' ')}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={secondsLeft}
          aria-valuemin={0}
          aria-valuemax={COUNTDOWN_SECONDS}
          aria-label={`${secondsLeft} seconds to respond`}
        />
      </div>

      {/* Header */}
      <div className={`px-6 pt-8 pb-6 ${bgCls}`}>
        <div className="flex items-center justify-between">
          <div className={`${iconCls} rounded-2xl bg-white/20 p-3`}>
            {NEED_ICONS[need.type]}
          </div>
          <div className="text-right">
            <p className="text-sm font-medium text-muted-foreground">New task assigned</p>
            <p className="text-3xl font-bold tabular-nums text-foreground" aria-live="polite">
              {secondsLeft}s
            </p>
          </div>
        </div>

        <h1
          id="task-modal-title"
          className="mt-4 text-xl font-bold leading-tight text-foreground"
        >
          {need.title}
        </h1>

        {message && (
          <p className="mt-1 text-base text-muted-foreground">{message}</p>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {/* Location */}
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-base font-medium text-foreground">{need.locationName}</p>
            {distanceM !== undefined && distanceM > 0 && (
              <p className="text-sm text-muted-foreground">{formatDistance(distanceM)}</p>
            )}
          </div>
        </div>

        {/* People affected */}
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-base text-foreground">
            {need.affectedCount} {need.affectedCount === 1 ? 'person' : 'people'} affected
            {need.hasVulnerable && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-sm font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                Vulnerable present
              </span>
            )}
          </p>
        </div>

        {/* Description */}
        {need.description && (
          <div className="rounded-xl bg-secondary p-4">
            <p className="text-base text-foreground">{need.description}</p>
          </div>
        )}

        {/* Error */}
        {submitError !== null && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {submitError}
          </div>
        )}

        {/* Decline form */}
        {showDecline && (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <p className="text-sm font-medium text-foreground">Why are you declining?</p>
            <select
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value as DeclineReason)}
              aria-label="Select decline reason"
              className="w-full rounded-lg border border-border bg-background px-3 py-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {DECLINE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleDecline(declineReason)}
              disabled={submitting}
              className="flex w-full min-h-[52px] items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 text-base font-semibold text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
              Confirm Decline
            </button>
            <button
              type="button"
              onClick={() => setShowDecline(false)}
              className="w-full text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Action buttons */}
      {!showDecline && (
        <div className="px-6 pb-8 space-y-3 border-t border-border pt-4">
          {/* ACCEPT */}
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={submitting}
            aria-busy={submitting}
            className={[
              'flex w-full min-h-[64px] items-center justify-center gap-3 rounded-2xl',
              'bg-success text-white text-xl font-bold',
              'transition-all hover:bg-success/90 active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30',
              'disabled:opacity-60',
              secondsLeft <= 10 ? 'animate-severity-pulse' : '',
            ].join(' ')}
          >
            {submitting
              ? <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
              : <span className="text-2xl" aria-hidden="true">✓</span>}
            {submitting ? 'Accepting…' : 'ACCEPT TASK'}
          </button>

          {/* DECLINE */}
          <button
            type="button"
            onClick={() => setShowDecline(true)}
            disabled={submitting}
            className="w-full py-3 text-base text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
