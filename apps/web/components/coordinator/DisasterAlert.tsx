'use client';

/**
 * DisasterAlert — pulsing top banner for urgent system-level events.
 *
 * Shows when any of these conditions are true:
 *  - An IMD RED alert is present in /disasterAlerts (RTDB)
 *  - More than 10 CRITICAL needs appeared in the last 5 minutes (spike)
 *  - The active disaster has CATASTROPHIC severity
 *
 * Dismissible per session.  Dismissals are logged via a fire-and-forget
 * fetch to /api/alerts/dismiss so coordinators can be called back.
 */

import * as React from 'react';
import { AlertTriangle, X, Zap, Radio } from 'lucide-react';
import { NeedSeverity, type CanonicalNeed, type RealtimeDisasterAlert } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DisasterAlertProps {
  needs:          readonly CanonicalNeed[];
  disasterAlerts: Readonly<Record<string, RealtimeDisasterAlert>>;
  disasterName:   string;
}

type AlertReason = 'imd_red' | 'critical_spike' | 'catastrophic' | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRITICAL_SPIKE_THRESHOLD   = 10;
const CRITICAL_SPIKE_WINDOW_MS   = 5 * 60 * 1000; // 5 minutes

function detectAlertReason(
  needs:          readonly CanonicalNeed[],
  disasterAlerts: Readonly<Record<string, RealtimeDisasterAlert>>,
): AlertReason {
  // IMD RED alert
  const hasRedAlert = Object.values(disasterAlerts).some(
    (a) => String(a.severity).toUpperCase() === 'CATASTROPHIC' || String(a.severity).toUpperCase() === 'RED',
  );
  if (hasRedAlert) return 'imd_red';

  // Critical need spike — more than THRESHOLD critical needs in the last 5 min
  const windowStart = Date.now() - CRITICAL_SPIKE_WINDOW_MS;
  const recentCritical = needs.filter(
    (n) =>
      n.severity === NeedSeverity.CRITICAL &&
      'seconds' in n.createdAt &&
      (n.createdAt as { seconds: number }).seconds * 1000 > windowStart,
  );
  if (recentCritical.length > CRITICAL_SPIKE_THRESHOLD) return 'critical_spike';

  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DisasterAlert({ needs, disasterAlerts, disasterName }: DisasterAlertProps) {
  const [dismissed, setDismissed] = React.useState(false);
  const [visible,   setVisible]   = React.useState(false);

  const reason = detectAlertReason(needs, disasterAlerts);
  const shouldShow = reason !== null && !dismissed;

  // Animate in when the alert first becomes relevant.
  React.useEffect(() => {
    if (shouldShow) {
      const id = setTimeout(() => setVisible(true), 16);
      return () => clearTimeout(id);
    } else {
      setVisible(false);
    }
    return undefined;
  }, [shouldShow]);

  const handleDismiss = () => {
    setDismissed(true);
    // Fire-and-forget: log the dismiss action.
    void fetch('/api/alerts/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, disasterName }),
    }).catch(() => undefined);
  };

  if (!shouldShow) return null;

  const config = {
    imd_red: {
      icon:    <Radio className="h-5 w-5" aria-hidden="true" />,
      title:   'IMD RED Alert Issued',
      message: `A RED alert has been issued for ${disasterName}. Activate all volunteers and pre-position resources.`,
      color:   'border-red-500 bg-red-950/90 text-red-100',
      pulse:   'animate-severity-pulse',
    },
    critical_spike: {
      icon:    <Zap className="h-5 w-5" aria-hidden="true" />,
      title:   'Critical Need Spike',
      message: `More than ${CRITICAL_SPIKE_THRESHOLD} critical needs reported in the last 5 minutes. Immediate action required.`,
      color:   'border-orange-500 bg-orange-950/90 text-orange-100',
      pulse:   'animate-severity-pulse',
    },
    catastrophic: {
      icon:    <AlertTriangle className="h-5 w-5" aria-hidden="true" />,
      title:   'Catastrophic Event',
      message: `${disasterName} has been classified as CATASTROPHIC. Request NDRF support immediately.`,
      color:   'border-red-500 bg-red-950/90 text-red-100',
      pulse:   'animate-severity-pulse',
    },
  } as const;

  const cfg = config[reason as keyof typeof config];

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={[
        'relative z-40 border-b-2 px-4 py-3',
        cfg.color,
        cfg.pulse,
        'transition-all duration-300',
        visible ? 'max-h-20 opacity-100' : 'max-h-0 opacity-0 overflow-hidden',
      ].join(' ')}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="shrink-0">{cfg.icon}</span>
          <div>
            <span className="font-semibold">{cfg.title}: </span>
            <span className="text-sm opacity-90">{cfg.message}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss alert"
          className="shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
