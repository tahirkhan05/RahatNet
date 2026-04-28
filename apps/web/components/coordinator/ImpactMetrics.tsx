'use client';

/**
 * ImpactMetrics — four live stat cards in the war-room right panel.
 *
 * Cards:
 *  1. Total needs reported
 *  2. Critical needs right now
 *  3. Active volunteers
 *  4. Resolution rate (% of needs resolved)
 *
 * Each card shows a trend indicator (↑/↓) compared to a snapshot taken
 * when the component mounts so coordinators can see whether the situation
 * is improving or deteriorating.
 *
 * Data comes from the parent via props (already computed in useWarRoom).
 * No additional subscriptions needed here.
 */

import * as React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Users,
  AlertTriangle,
  CheckCircle2,
  Activity,
  ClipboardList,
} from 'lucide-react';
import type { WarRoomStats } from '@/hooks/useWarRoom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImpactMetricsProps {
  stats: WarRoomStats;
  isLoading: boolean;
}

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  iconColor: string;
  trend?: 'up' | 'down' | 'neutral';
  trendLabel?: string;
  isLoading: boolean;
  highlight?: boolean;
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon,
  iconColor,
  trend,
  trendLabel,
  isLoading,
  highlight,
}: StatCardProps) {
  return (
    <div
      className={[
        'rounded-xl border p-4 transition-colors',
        highlight ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-muted-foreground text-xs font-medium">{label}</p>
          {isLoading ? (
            <div className="skeleton-shimmer mt-1 h-8 w-16 rounded" />
          ) : (
            <p
              className={[
                'mt-1 text-3xl font-bold tabular-nums',
                highlight ? 'text-destructive' : 'text-foreground',
              ].join(' ')}
            >
              {value}
            </p>
          )}
        </div>
        <div className={`rounded-lg p-2 ${iconColor}`}>{icon}</div>
      </div>

      {!isLoading && trend != null && trendLabel != null && (
        <div className="mt-3 flex items-center gap-1 text-xs">
          {trend === 'up' ? (
            <TrendingUp className="text-destructive h-3 w-3" aria-hidden="true" />
          ) : trend === 'down' ? (
            <TrendingDown className="text-success h-3 w-3" aria-hidden="true" />
          ) : (
            <Minus className="text-muted-foreground h-3 w-3" aria-hidden="true" />
          )}
          <span
            className={
              trend === 'up'
                ? 'text-destructive'
                : trend === 'down'
                  ? 'text-success'
                  : 'text-muted-foreground'
            }
          >
            {trendLabel}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImpactMetrics
// ---------------------------------------------------------------------------

export function ImpactMetrics({ stats, isLoading }: ImpactMetricsProps) {
  // Capture baseline on first render to compute trends.
  const baselineRef = React.useRef<WarRoomStats | null>(null);

  React.useEffect(() => {
    if (!isLoading && baselineRef.current === null) {
      baselineRef.current = { ...stats };
    }
  }, [isLoading, stats]);

  const baseline = baselineRef.current;

  const resolutionRate = stats.total > 0 ? Math.round((stats.resolved / stats.total) * 100) : 0;

  const totalTrend = !baseline
    ? 'neutral'
    : stats.total > baseline.total
      ? 'up'
      : stats.total < baseline.total
        ? 'down'
        : 'neutral';

  const criticalTrend = !baseline
    ? 'neutral'
    : stats.critical > baseline.critical
      ? 'up'
      : stats.critical < baseline.critical
        ? 'down'
        : 'neutral';

  return (
    <div className="space-y-3" aria-label="Impact metrics">
      <StatCard
        label="Total Needs"
        value={stats.total}
        icon={<Activity className="h-5 w-5" aria-hidden="true" />}
        iconColor="bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400"
        trend={totalTrend}
        trendLabel={
          !baseline
            ? undefined
            : stats.total === baseline.total
              ? 'No change'
              : `${Math.abs(stats.total - baseline.total)} since start`
        }
        isLoading={isLoading}
      />

      <StatCard
        label="Critical Right Now"
        value={stats.critical}
        icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
        iconColor="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"
        trend={criticalTrend}
        trendLabel={
          !baseline
            ? undefined
            : stats.critical === baseline.critical
              ? 'Stable'
              : `${stats.critical > baseline.critical ? '+' : ''}${stats.critical - baseline.critical} since start`
        }
        isLoading={isLoading}
        highlight={stats.critical > 0}
      />

      <StatCard
        label="Active Volunteers"
        value={stats.activeVolunteers}
        icon={<Users className="h-5 w-5" aria-hidden="true" />}
        iconColor="bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400"
        isLoading={isLoading}
      />

      <StatCard
        label="Resolution Rate"
        value={`${resolutionRate}%`}
        icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
        iconColor="bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
        trend={resolutionRate > 50 ? 'down' : resolutionRate > 0 ? 'neutral' : 'up'}
        trendLabel={`${stats.resolved} of ${stats.total} resolved`}
        isLoading={isLoading}
      />

      <StatCard
        label="Survey Reports"
        value={stats.surveyCount}
        icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
        iconColor="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
        trendLabel={stats.surveyCount > 0 ? 'Pre-mapped vulnerabilities' : 'No surveys yet'}
        trend="neutral"
        isLoading={isLoading}
      />
    </div>
  );
}
