'use client';

/**
 * WarRoomDashboard — top-level client component for /coordinator/war-room.
 *
 * Responsibilities:
 *  - Wraps all sub-components with an Error Boundary around the map.
 *  - Manages the global "selected need" state shared between queue and map.
 *  - Manages the assign-modal open/close lifecycle.
 *  - Registers keyboard shortcuts:
 *      A — open assign modal for the selected need
 *      M — focus the map (blur the queue)
 *      F — focus the filter/search input in the queue
 *      Escape — deselect / close modal
 *  - Provides the three-column layout (queue | map | stats).
 *  - Passes disaster event ID down to useWarRoom.
 *
 * The layout is desktop-first (the war room is used on large monitors).
 * On mobile it stacks vertically with the map hidden behind a tab.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, RefreshCw, Clock, Wifi, ArrowLeft } from 'lucide-react';
import {
  DisasterStatus, DisasterSeverity,
  type CanonicalNeed,
} from '@rahatnet/types';
import { useWarRoom } from '@/hooks/useWarRoom';
import { DisasterAlert }      from './DisasterAlert';
import { ImpactMetrics }      from './ImpactMetrics';
import { ImpactAnalytics }    from './ImpactAnalytics';
import { NeedQueue }          from './NeedQueue';
import { WarRoomMap }         from './WarRoomMap';
import { AssignVolunteerModal } from './AssignVolunteerModal';

// ---------------------------------------------------------------------------
// Map Error Boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryState { hasError: boolean; error: Error | null }

class MapErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }
  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-secondary p-6 text-center">
          <AlertCircle className="h-10 w-10 text-destructive" aria-hidden="true" />
          <p className="font-semibold text-foreground">Map failed to load</p>
          <p className="text-sm text-muted-foreground">
            {this.state.error?.message ?? 'An unexpected error occurred'}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// War Room Header
// ---------------------------------------------------------------------------

function WarRoomHeader({
  disasterName, status, severity, lastUpdated, isOnline,
}: {
  disasterName: string;
  status:       DisasterStatus | null;
  severity:     DisasterSeverity | null;
  lastUpdated:  Date;
  isOnline:     boolean;
}) {
  const severityColor: Record<DisasterSeverity, string> = {
    [DisasterSeverity.LOW]:          'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    [DisasterSeverity.MODERATE]:     'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    [DisasterSeverity.SEVERE]:       'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    [DisasterSeverity.CATASTROPHIC]: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  };

  const statusColor: Record<DisasterStatus, string> = {
    [DisasterStatus.MONITORING]:    'bg-blue-100 text-blue-800 dark:bg-blue-900',
    [DisasterStatus.ACTIVE]:        'bg-green-100 text-green-800 dark:bg-green-900',
    [DisasterStatus.WINDING_DOWN]:  'bg-amber-100 text-amber-800 dark:bg-amber-900',
    [DisasterStatus.RESOLVED]:      'bg-secondary text-muted-foreground',
  };

  const relTime = (d: Date) => {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/coordinator"
          className="shrink-0 flex items-center gap-1 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold text-foreground">{disasterName}</h1>
        </div>
        {status !== null && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[status]}`}>
            {status}
          </span>
        )}
        {severity !== null && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${severityColor[severity]}`}>
            {severity}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Updated {relTime(lastUpdated)}
        </span>
        <span className={`flex items-center gap-1 ${isOnline ? 'text-success' : 'text-destructive'}`}>
          <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
          {isOnline ? 'Live' : 'Offline'}
        </span>
        <a
          href="/coordinator/needs"
          className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
        >
          Full queue →
        </a>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

interface WarRoomDashboardProps {
  disasterEventId: string;
}

export function WarRoomDashboard({ disasterEventId }: WarRoomDashboardProps) {
  const {
    needs, volunteerLocations, disasterAlerts,
    activeDisaster, stats, isLoading, error, refresh,
  } = useWarRoom(disasterEventId);

  const [selectedNeed, setSelectedNeed]   = React.useState<CanonicalNeed | null>(null);
  const [assignTarget, setAssignTarget]   = React.useState<CanonicalNeed | null>(null);
  const [lastUpdated]                     = React.useState(new Date());
  const [isOnline,     setIsOnline]       = React.useState(true);

  // Track online status.
  React.useEffect(() => {
    const onOnline  = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire shortcuts when the user is typing in an input.
      const tag = (e.target as HTMLElement).tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      switch (e.key) {
        case 'A':
        case 'a':
          if (selectedNeed !== null) {
            e.preventDefault();
            setAssignTarget(selectedNeed);
          }
          break;

        case 'F':
        case 'f':
          e.preventDefault();
          document.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
          break;

        case 'Escape':
          setAssignTarget(null);
          setSelectedNeed(null);
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedNeed]);

  // ── Optimistic assignment update ──────────────────────────────────────────

  const handleAssigned = React.useCallback(
    (_needId: string, _volunteerId: string) => {
      // useWarRoom's Firestore subscription will pick up the real update within
      // ~200 ms.  We just close the modal here.
      setAssignTarget(null);
    },
    [],
  );

  const handleMarkDuplicate = React.useCallback((need: CanonicalNeed) => {
    // Fire-and-forget: coordinator marks the need as a duplicate.
    void fetch(`/api/needs/${need.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'DUPLICATE' }),
    }).catch(() => undefined);
  }, []);

  // ── Error state ───────────────────────────────────────────────────────────

  if (error !== null && !isLoading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 text-center p-6">
        <AlertCircle className="h-12 w-12 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-lg font-semibold text-foreground">Failed to load war room</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const disasterName = activeDisaster?.name ?? 'Active Disaster';
  const boundingBox  = activeDisaster?.boundingBox ?? null;

  return (
    <div className="rn-war-room">
      {/* Disaster alert banner (above header) */}
      <DisasterAlert
        needs={needs}
        disasterAlerts={disasterAlerts}
        disasterName={disasterName}
      />

      {/* Header */}
      <WarRoomHeader
        disasterName={disasterName}
        status={activeDisaster?.status ?? null}
        severity={activeDisaster?.severity ?? null}
        lastUpdated={lastUpdated}
        isOnline={isOnline}
      />

      {/* Three-column body — fills the 1fr grid row */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left — Priority Queue */}
        <aside
          className="w-72 shrink-0 border-r border-border"
          aria-label="Priority queue"
        >
          <NeedQueue
            needs={needs}
            isLoading={isLoading}
            selectedNeed={selectedNeed}
            onSelect={setSelectedNeed}
            onAssign={setAssignTarget}
            onDuplicate={handleMarkDuplicate}
          />
        </aside>

        {/* Centre — Live Map */}
        <main className="flex-1 min-w-0" aria-label="Live disaster map">
          <MapErrorBoundary>
            <WarRoomMap
              needs={needs}
              volunteerLocations={volunteerLocations}
              boundingBox={boundingBox}
              selectedNeed={selectedNeed}
              onNeedClick={(need) => {
                setSelectedNeed(need);
              }}
            />
          </MapErrorBoundary>
        </main>

        {/* Right — Stats + Analytics (double-width, side-by-side) */}
        <aside
          className="w-[34rem] shrink-0 border-l border-border flex divide-x divide-border overflow-hidden"
          aria-label="Impact metrics and analytics"
        >
          {/* Left half — Key metrics + shortcuts */}
          <div className="w-56 shrink-0 overflow-y-auto p-3 rn-scroll-panel">
            <ImpactMetrics stats={stats} isLoading={isLoading} />
            <div className="mt-4 rounded-lg bg-secondary px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">Shortcuts</p>
              <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                <p><kbd className="rounded bg-background px-1 py-0.5 font-mono">A</kbd> Assign selected</p>
                <p><kbd className="rounded bg-background px-1 py-0.5 font-mono">F</kbd> Focus search</p>
                <p><kbd className="rounded bg-background px-1 py-0.5 font-mono">Esc</kbd> Deselect</p>
              </div>
            </div>
          </div>

          {/* Right half — Live analytics charts */}
          <div className="flex-1 min-w-0 overflow-y-auto p-3 rn-scroll-panel">
            <ImpactAnalytics
              disasterEventId={disasterEventId}
              onTypeFilter={(type) => { void type; }}
            />
          </div>
        </aside>
      </div>

      {/* Assign volunteer modal */}
      {assignTarget !== null && (
        <AssignVolunteerModal
          need={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={handleAssigned}
        />
      )}
    </div>
  );
}
