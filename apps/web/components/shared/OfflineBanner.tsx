'use client';

/**
 * OfflineBanner — sticky top banner for network state feedback.
 *
 * Renders one of three states (in priority order):
 *
 *   1. OFFLINE     — "You're offline. Reports saved locally."
 *                    Shown whenever isOnline === false.
 *
 *   2. SLOW        — "Slow connection. Photos may take longer."
 *                    Shown when online but isSlowConnection === true.
 *                    Dismissible (stays dismissed for the session).
 *
 *   3. PENDING     — "N report(s) waiting to be sent."
 *                    Shown when online, not slow (or slow dismissed),
 *                    and pendingCount > 0.
 *                    Auto-hides when count reaches 0.
 *
 * Animation:
 *   Slides in from the top when it first appears and slides out when
 *   it should disappear.  Uses CSS transforms so it works on GPU-composited
 *   layers — no layout thrash on low-end Android phones.
 *
 * Accessibility:
 *   - role="status" + aria-live="polite" for the slow/pending messages
 *     (not urgent — a screen reader announces them after the current task).
 *   - role="alert" + aria-live="assertive" for the offline message
 *     (urgent — screen reader interrupts current announcement).
 *   - The dismiss button has a descriptive aria-label.
 */

import * as React from 'react';
import { WifiOff, Wifi, Clock, X, Send } from 'lucide-react';
import { useOffline } from '@/hooks/useOffline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BannerVariant = 'offline' | 'slow' | 'pending' | 'none';

// ---------------------------------------------------------------------------
// Individual banner rows
// ---------------------------------------------------------------------------

interface BannerRowProps {
  icon:      React.ReactNode;
  message:   React.ReactNode;
  variant:   'error' | 'warning' | 'info';
  onDismiss?: () => void;
  ariaLive:  'assertive' | 'polite';
}

function BannerRow({ icon, message, variant, onDismiss, ariaLive }: BannerRowProps) {
  const colors: Record<typeof variant, string> = {
    error:   'bg-destructive/10 border-destructive/30 text-destructive',
    warning: 'bg-warning/10 border-warning/30 text-foreground',
    info:    'bg-info/10 border-info/30 text-foreground',
  };

  const iconColors: Record<typeof variant, string> = {
    error:   'text-destructive',
    warning: 'text-warning',
    info:    'text-info',
  };

  return (
    <div
      role={ariaLive === 'assertive' ? 'alert' : 'status'}
      aria-live={ariaLive}
      className={`flex items-center gap-2.5 border-b px-4 py-2.5 text-sm ${colors[variant]}`}
    >
      <span className={`shrink-0 ${iconColors[variant]}`} aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this notification"
          className={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded',
            'opacity-60 transition-opacity hover:opacity-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          ].join(' ')}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface OfflineBannerProps {
  /** Override isOnline for testing. */
  forceOffline?: boolean;
}

export function OfflineBanner({ forceOffline = false }: OfflineBannerProps) {
  const { isOnline, isSlowConnection, pendingCount } = useOffline();
  const [slowDismissed, setSlowDismissed] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  // Determine which banner variant is active.
  const offline  = forceOffline || !isOnline;
  const slow     = isOnline && isSlowConnection && !slowDismissed;
  const pending  = isOnline && !slow && pendingCount > 0;

  const activeVariant: BannerVariant =
    offline ? 'offline' : slow ? 'slow' : pending ? 'pending' : 'none';

  // Animate in/out by driving `visible` slightly after `mounted` so the
  // CSS transition has a rendered initial state to transition from.
  React.useEffect(() => {
    setMounted(activeVariant !== 'none');
  }, [activeVariant]);

  React.useEffect(() => {
    if (mounted) {
      // Small delay so the element is in the DOM before we start the transition.
      const id = setTimeout(() => setVisible(true), 16);
      return () => clearTimeout(id);
    } else {
      setVisible(false);
    }
    return undefined;
  }, [mounted]);

  if (!mounted && !visible) return null;

  return (
    <div
      aria-hidden={!visible}
      className={[
        'sticky left-0 right-0 top-0 z-50 overflow-hidden shadow-md transition-all duration-300 ease-out',
        visible ? 'max-h-16 opacity-100' : 'max-h-0 opacity-0',
      ].join(' ')}
    >
      {activeVariant === 'offline' && (
        <BannerRow
          ariaLive="assertive"
          variant="error"
          icon={<WifiOff className="h-4 w-4" />}
          message={
            <>
              <strong>You're offline.</strong>{' '}
              Reports will be saved and sent when you reconnect.
              {pendingCount > 0 && (
                <span className="ml-1 opacity-75">
                  ({pendingCount} report{pendingCount !== 1 ? 's' : ''} queued)
                </span>
              )}
            </>
          }
        />
      )}

      {activeVariant === 'slow' && (
        <BannerRow
          ariaLive="polite"
          variant="warning"
          icon={<Wifi className="h-4 w-4" />}
          message="Slow connection detected. Large photos may not upload."
          onDismiss={() => setSlowDismissed(true)}
        />
      )}

      {activeVariant === 'pending' && (
        <BannerRow
          ariaLive="polite"
          variant="info"
          icon={<Send className="h-4 w-4" />}
          message={
            <>
              <Clock className="mr-1 inline h-3.5 w-3.5 align-text-bottom" aria-hidden="true" />
              {pendingCount} report{pendingCount !== 1 ? 's' : ''} waiting to be sent…
            </>
          }
        />
      )}
    </div>
  );
}
