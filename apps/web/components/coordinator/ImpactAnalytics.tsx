'use client';

/**
 * ImpactAnalytics — war-room analytics drawer with five live charts.
 *
 * Charts:
 *  1. Response Time Line  — 15-min buckets, target line at 8 min, recharts LineChart
 *  2. Resolution Funnel   — stage-by-stage drop-off, custom bar funnel
 *  3. Volunteer Heatmap   — activity by hour of day, recharts BarChart
 *  4. Need Type Donut     — recharts PieChart, click-to-filter callback
 *  5. Geographic Coverage — simple progress bars
 *
 * Data: fetched from GET /api/analytics?disasterId=X&timeRange=4h.
 * Refetched every 60 seconds to match the API cache TTL.
 *
 * Accessibility:
 *  - Each chart container has role="img" + aria-label.
 *  - Screen-reader-only <table> mirrors every chart's data for keyboard users.
 *  - Retry button on error state.
 *  - Loading skeletons use aria-busy.
 *
 * @react-pdf/renderer is NOT used here — PDF export lives in ResourceTracker.
 */

import * as React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, PieChart, Pie, Cell,
  BarChart, Bar, Legend,
} from 'recharts';
import { RefreshCw, AlertCircle, Clock, TrendingDown } from 'lucide-react';
import type { AnalyticsPayload, ResponseTimePoint, FunnelStage, HeatmapCell, TypeBreakdownSlice } from '@/app/api/analytics/route';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ImpactAnalyticsProps {
  disasterEventId:   string;
  /** Called when user clicks a donut slice — parent can filter the need queue. */
  onTypeFilter?:     (type: string | null) => void;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const REFETCH_INTERVAL_MS = 60_000;

type TimeRange = '1h' | '4h' | '12h' | '24h';

function useAnalytics(disasterId: string, timeRange: TimeRange) {
  const [data,      setData]      = React.useState<AnalyticsPayload | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error,     setError]     = React.useState<string | null>(null);

  const fetchData = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/analytics?disasterId=${encodeURIComponent(disasterId)}&timeRange=${timeRange}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Analytics unavailable');
      }
      const json = (await res.json()) as { data: AnalyticsPayload };
      setData(json.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analytics unavailable');
    } finally {
      setIsLoading(false);
    }
  }, [disasterId, timeRange]);

  React.useEffect(() => {
    setIsLoading(true);
    void fetchData();
    const id = setInterval(() => void fetchData(), REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function ChartSkeleton({ height = 160 }: { height?: number }) {
  return (
    <div
      className="skeleton-shimmer rounded-xl"
      style={{ height }}
      aria-busy="true"
      aria-label="Loading chart…"
    />
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

// Format time bucket label: ISO → "14:30"
function formatBucketTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso.slice(11, 16);
  }
}

// ---------------------------------------------------------------------------
// 1. Response Time Line Chart
// ---------------------------------------------------------------------------

const TARGET_MINUTES = 8;

function ResponseTimeChart({ points, isLoading }: { points: ResponseTimePoint[]; isLoading: boolean }) {
  if (isLoading) return <ChartSkeleton height={160} />;

  const chartData = points.map((p) => ({
    time:    formatBucketTime(p.time),
    minutes: p.avgMinutes,
    samples: p.sampleSize,
  }));

  return (
    <div>
      <SectionTitle>Avg Response Time (min)</SectionTitle>

      <div
        role="img"
        aria-label={`Response time chart. Target is ${TARGET_MINUTES} minutes.`}
        className="h-40"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              domain={[0, 'auto']}
            />
            <Tooltip
              contentStyle={{ fontSize: 11, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
              labelStyle={{ color: 'hsl(var(--foreground))' }}
              formatter={(v: number) => [`${v} min`, 'Avg response']}
            />
            <ReferenceLine
              y={TARGET_MINUTES}
              stroke="#ef4444"
              strokeDasharray="4 2"
              label={{ value: `Target ${TARGET_MINUTES}m`, fill: '#ef4444', fontSize: 9, position: 'right' }}
            />
            <Line
              type="monotone"
              dataKey="minutes"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Screen-reader table */}
      <table className="sr-only" aria-label="Response time data">
        <thead><tr><th>Time</th><th>Avg Minutes</th><th>Samples</th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.time}>
              <td>{formatBucketTime(p.time)}</td>
              <td>{p.avgMinutes}</td>
              <td>{p.sampleSize}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Resolution Funnel
// ---------------------------------------------------------------------------

const FUNNEL_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

function ResolutionFunnel({ stages, isLoading }: { stages: FunnelStage[]; isLoading: boolean }) {
  if (isLoading) return <ChartSkeleton height={140} />;
  if (stages.length === 0) return null;

  const maxCount = stages[0]?.count ?? 1;

  return (
    <div>
      <SectionTitle>Resolution Funnel</SectionTitle>
      <div
        role="img"
        aria-label="Resolution funnel chart showing drop-off at each stage"
        className="space-y-1.5"
      >
        {stages.map((stage, i) => {
          const width = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
          const color = FUNNEL_COLORS[i % FUNNEL_COLORS.length] ?? '#6b7280';

          return (
            <div key={stage.status} className="group">
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className="font-medium text-foreground">{stage.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {stage.count} ({stage.percentage}%)
                </span>
              </div>
              <div className="h-5 w-full overflow-hidden rounded bg-secondary">
                <div
                  className="h-full rounded transition-all duration-500"
                  style={{ width: `${width}%`, backgroundColor: color }}
                  role="progressbar"
                  aria-valuenow={stage.percentage}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${stage.label}: ${stage.count} needs (${stage.percentage}%)`}
                />
              </div>
              {stage.dropOffRate > 0 && (
                <div className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                  <TrendingDown className="h-2.5 w-2.5" aria-hidden="true" />
                  {stage.dropOffRate}% drop-off
                </div>
              )}
            </div>
          );
        })}
      </div>

      <table className="sr-only" aria-label="Funnel stage data">
        <thead><tr><th>Stage</th><th>Count</th><th>Percentage</th><th>Drop-off</th></tr></thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.status}>
              <td>{s.label}</td><td>{s.count}</td>
              <td>{s.percentage}%</td><td>{s.dropOffRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Volunteer Activity Heatmap (hour-of-day bar chart)
// ---------------------------------------------------------------------------

function VolunteerHeatmap({ cells, isLoading }: { cells: HeatmapCell[]; isLoading: boolean }) {
  if (isLoading) return <ChartSkeleton height={100} />;

  return (
    <div>
      <SectionTitle>Volunteer Activity by Hour</SectionTitle>
      <div
        role="img"
        aria-label="Bar chart showing volunteer activity by hour of day"
        className="h-24"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={cells} margin={{ top: 2, right: 4, bottom: 0, left: -28 }}>
            <XAxis
              dataKey="hour"
              tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
              tickFormatter={(h: number) => h % 6 === 0 ? `${h}:00` : ''}
            />
            <YAxis tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }} />
            <Tooltip
              contentStyle={{ fontSize: 10, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
              formatter={(v: number) => [v, 'Assignments']}
              labelFormatter={(h: number) => `${h}:00 – ${h + 1}:00`}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only" aria-label="Volunteer activity data">
        <thead><tr><th>Hour</th><th>Assignments</th></tr></thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.hour}>
              <td>{c.hour}:00</td><td>{c.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Need Type Donut Chart
// ---------------------------------------------------------------------------

function TypeDonut({
  slices, isLoading, onTypeFilter,
}: {
  slices:        TypeBreakdownSlice[];
  isLoading:     boolean;
  onTypeFilter?: (type: string | null) => void;
}) {
  const [activeType, setActiveType] = React.useState<string | null>(null);

  if (isLoading) return <ChartSkeleton height={140} />;

  const nonEmpty = slices.filter((s) => s.count > 0);
  if (nonEmpty.length === 0) return null;

  const handleClick = (slice: TypeBreakdownSlice) => {
    const next = activeType === slice.type ? null : slice.type;
    setActiveType(next);
    onTypeFilter?.(next);
  };

  return (
    <div>
      <SectionTitle>Need Type Breakdown</SectionTitle>
      <div
        role="img"
        aria-label="Donut chart showing breakdown of need types"
        className="flex items-center gap-4"
      >
        <div className="h-32 w-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={nonEmpty}
                cx="50%"
                cy="50%"
                innerRadius="55%"
                outerRadius="90%"
                dataKey="count"
                paddingAngle={2}
                onClick={(entry: TypeBreakdownSlice) => handleClick(entry)}
                tabIndex={0}
                onKeyDown={(e) => {
                  // Keyboard navigation through slices is handled via the legend buttons below.
                  void e;
                }}
              >
                {nonEmpty.map((slice) => (
                  <Cell
                    key={slice.type}
                    fill={slice.color}
                    opacity={activeType === null || activeType === slice.type ? 1 : 0.4}
                    style={{ cursor: 'pointer', outline: 'none' }}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ fontSize: 10, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(v: any, _: any, props: any) =>
                  [`${v} (${props.payload.percentage}%)`, props.payload.label]
                }
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Legend — also serves as keyboard-accessible slice selector */}
        <ul className="flex-1 space-y-1" aria-label="Need type legend — click to filter queue">
          {nonEmpty.map((slice) => (
            <li key={slice.type}>
              <button
                type="button"
                onClick={() => handleClick(slice)}
                aria-pressed={activeType === slice.type}
                className={[
                  'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition-opacity',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  activeType !== null && activeType !== slice.type ? 'opacity-40' : 'opacity-100',
                ].join(' ')}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.color }}
                  aria-hidden="true"
                />
                <span className="flex-1 font-medium text-foreground">{slice.label}</span>
                <span className="tabular-nums text-muted-foreground">{slice.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {activeType !== null && (
        <button
          type="button"
          onClick={() => { setActiveType(null); onTypeFilter?.(null); }}
          className="mt-1.5 text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
        >
          Clear filter
        </button>
      )}

      <table className="sr-only" aria-label="Need type breakdown data">
        <thead><tr><th>Type</th><th>Count</th><th>Percentage</th></tr></thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.type}>
              <td>{s.label}</td><td>{s.count}</td><td>{s.percentage}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Geographic Coverage
// ---------------------------------------------------------------------------

function GeoCoverage({
  coveragePercent, resolvedPercent, totalNeeds, isLoading,
}: {
  coveragePercent: number;
  resolvedPercent: number;
  totalNeeds:      number;
  isLoading:       boolean;
}) {
  if (isLoading) return <ChartSkeleton height={60} />;

  return (
    <div>
      <SectionTitle>Coverage</SectionTitle>
      <div className="space-y-2" aria-label="Geographic coverage metrics">
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted-foreground">Zone with needs reported</span>
            <span className="font-semibold tabular-nums text-foreground">{coveragePercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-700"
              style={{ width: `${coveragePercent}%` }}
              role="progressbar"
              aria-valuenow={coveragePercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${coveragePercent}% of disaster zone has reported needs`}
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted-foreground">Needs resolved</span>
            <span className="font-semibold tabular-nums text-foreground">{resolvedPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-green-500 transition-all duration-700"
              style={{ width: `${resolvedPercent}%` }}
              role="progressbar"
              aria-valuenow={resolvedPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${resolvedPercent}% of needs resolved`}
            />
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground">
          {totalNeeds} total needs across disaster zone
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time range selector
// ---------------------------------------------------------------------------

const TIME_RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '1h',  label: '1h'  },
  { value: '4h',  label: '4h'  },
  { value: '12h', label: '12h' },
  { value: '24h', label: '24h' },
];

// ---------------------------------------------------------------------------
// ImpactAnalytics — top-level
// ---------------------------------------------------------------------------

export function ImpactAnalytics({ disasterEventId, onTypeFilter }: ImpactAnalyticsProps) {
  const [timeRange,  setTimeRange]  = React.useState<TimeRange>('4h');
  const [lastFetched, setLastFetched] = React.useState<Date | null>(null);

  const { data, isLoading, error, refetch } = useAnalytics(disasterEventId, timeRange);

  React.useEffect(() => {
    if (data != null) setLastFetched(new Date());
  }, [data]);

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (!isLoading && error !== null) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">Analytics unavailable</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{error}</p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Normal render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5" aria-label="Impact analytics">
      {/* Controls row */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Analytics</h2>
        <div className="flex items-center gap-2">
          {/* Time range selector */}
          <div className="flex rounded-lg border border-border overflow-hidden" role="group" aria-label="Time range">
            {TIME_RANGES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTimeRange(value)}
                aria-pressed={timeRange === value}
                className={[
                  'px-2 py-1 text-[11px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  timeRange === value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh analytics"
            className="rounded-lg border border-border bg-background p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Last fetched timestamp */}
      {lastFetched !== null && !isLoading && (
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Updated {lastFetched.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      )}

      {/* Chart 1: Response time */}
      <ResponseTimeChart
        points={data?.responseTimes ?? []}
        isLoading={isLoading}
      />

      {/* Chart 2: Funnel */}
      <ResolutionFunnel
        stages={data?.funnel ?? []}
        isLoading={isLoading}
      />

      {/* Chart 3: Donut */}
      <TypeDonut
        slices={data?.typeBreakdown ?? []}
        isLoading={isLoading}
        onTypeFilter={onTypeFilter}
      />

      {/* Chart 4: Volunteer heatmap */}
      <VolunteerHeatmap
        cells={data?.heatmap ?? []}
        isLoading={isLoading}
      />

      {/* Chart 5: Coverage */}
      <GeoCoverage
        coveragePercent={data?.coveragePercent ?? 0}
        resolvedPercent={data?.resolvedPercent ?? 0}
        totalNeeds={data?.totalNeeds ?? 0}
        isLoading={isLoading}
      />
    </div>
  );
}
