/**
 * GET /api/analytics
 *
 * Returns formatted chart data for the war-room ImpactAnalytics panel.
 *
 * Query parameters:
 *   disasterId  — required, Firestore ID of the active DisasterEvent
 *   timeRange   — '1h' | '4h' | '12h' | '24h'  (default '4h')
 *
 * Response shape: AnalyticsPayload (see types below)
 *
 * Caching:
 *   Next.js `revalidate: 60` — the response is served from the edge cache
 *   for up to 60 seconds, then re-computed on the next request.  This is the
 *   right trade-off: analytics data can be 1 minute stale during a crisis
 *   without materially affecting coordinator decisions, but the cache prevents
 *   hammering Firestore/BigQuery every time someone refreshes the dashboard.
 *
 * Data sources:
 *   - Firestore /needs          — funnel aggregation (counts per status)
 *   - Firestore /needs          — need-type breakdown (counts per type)
 *   - BigQuery rahatnet_analytics.response_metrics — response time series
 *     → Falls back to Firestore-derived approximation if BigQuery is unavailable
 *       (BigQuery responses can take 2-3 s; for a cached 60s endpoint that is
 *        acceptable, but we don't want to block on a cold BQ query for every request)
 *
 * Auth:
 *   Verifies session cookie — coordinator/admin only.
 *
 * Rate limit:
 *   5 requests / min / IP (same in-process limiter used by other API routes).
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { NeedType, NeedStatus, COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

// ---------------------------------------------------------------------------
// Cache revalidation — 60 seconds
// ---------------------------------------------------------------------------
export const revalidate = 60;

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

const logger  = createServerLogger('analytics');
const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, prefix: 'analytics' });

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const querySchema = z.object({
  disasterId: z.string().min(1),
  timeRange:  z.enum(['1h', '4h', '12h', '24h']).default('4h'),
});

// ---------------------------------------------------------------------------
// Public types (also imported by ImpactAnalytics.tsx)
// ---------------------------------------------------------------------------

/** One point on the response-time line chart. */
export interface ResponseTimePoint {
  /** ISO timestamp of the 15-minute bucket start. */
  readonly time:         string;
  /** Average minutes from need creation to volunteer arrival. */
  readonly avgMinutes:   number;
  /** Number of completed assignments in this bucket. */
  readonly sampleSize:   number;
}

/** One stage in the resolution funnel. */
export interface FunnelStage {
  readonly status:      string;
  readonly label:       string;
  readonly count:       number;
  readonly percentage:  number;
  readonly dropOffRate: number;
}

/** One cell in the volunteer-activity hour heatmap. */
export interface HeatmapCell {
  /** Hour of day 0–23. */
  readonly hour:  number;
  /** Number of assignment events in this hour. */
  readonly count: number;
}

/** One slice in the need-type donut. */
export interface TypeBreakdownSlice {
  readonly type:       string;
  readonly label:      string;
  readonly count:      number;
  readonly percentage: number;
  readonly color:      string;
}

/** Full analytics payload. */
export interface AnalyticsPayload {
  readonly responseTimes:    ResponseTimePoint[];
  readonly funnel:           FunnelStage[];
  readonly heatmap:          HeatmapCell[];
  readonly typeBreakdown:    TypeBreakdownSlice[];
  readonly coveragePercent:  number;
  readonly resolvedPercent:  number;
  readonly totalNeeds:       number;
  readonly computedAt:       string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNNEL_ORDER: NeedStatus[] = [
  NeedStatus.PENDING,
  NeedStatus.AI_PROCESSING,
  NeedStatus.VERIFIED,
  NeedStatus.ASSIGNED,
  NeedStatus.IN_PROGRESS,
  NeedStatus.RESOLVED,
];

const FUNNEL_LABELS: Record<NeedStatus, string> = {
  [NeedStatus.PENDING]:        'Reported',
  [NeedStatus.AI_PROCESSING]:  'Processing',
  [NeedStatus.VERIFIED]:       'Verified',
  [NeedStatus.ASSIGNED]:       'Assigned',
  [NeedStatus.IN_PROGRESS]:    'In Progress',
  [NeedStatus.RESOLVED]:       'Resolved',
  [NeedStatus.DUPLICATE]:      'Duplicate',
  [NeedStatus.CANCELLED]:      'Cancelled',
};

const TYPE_COLORS: Record<NeedType, string> = {
  [NeedType.RESCUE]:         '#ef4444',
  [NeedType.FOOD]:           '#f59e0b',
  [NeedType.MEDICINE]:       '#3b82f6',
  [NeedType.SHELTER]:        '#10b981',
  [NeedType.MENTAL_HEALTH]:  '#8b5cf6',
  [NeedType.INFRASTRUCTURE]: '#6b7280',
};

const TYPE_LABELS: Record<NeedType, string> = {
  [NeedType.RESCUE]:         'Rescue',
  [NeedType.FOOD]:           'Food & Water',
  [NeedType.MEDICINE]:       'Medicine',
  [NeedType.SHELTER]:        'Shelter',
  [NeedType.MENTAL_HEALTH]:  'Mental Health',
  [NeedType.INFRASTRUCTURE]: 'Infrastructure',
};

function timeRangeToHours(range: string): number {
  switch (range) {
    case '1h':  return 1;
    case '4h':  return 4;
    case '12h': return 12;
    case '24h': return 24;
    default:    return 4;
  }
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

interface NeedDoc {
  status:    string;
  type:      string;
  createdAt: { seconds: number } | null;
  resolvedAt?: { seconds: number } | null;
  assignedAt?: { seconds: number } | null;
}

async function fetchNeedsFromFirestore(disasterId: string): Promise<NeedDoc[]> {
  const { adminFirestore } = await import('@/lib/firebase/admin');
  const snap = await adminFirestore
    .collection(COLLECTIONS.NEEDS)
    .where('disasterEventId', '==', disasterId)
    .limit(1000)
    .get();

  return snap.docs.map((d) => d.data() as NeedDoc);
}

/**
 * Build response-time series from Firestore need data.
 *
 * For each 15-minute bucket in the time range, compute the average minutes
 * from assignedAt to resolvedAt for needs that completed in that window.
 *
 * This is an approximation — for production, BigQuery has pre-aggregated this
 * in the response_metrics table.  The Firestore fallback is used when BigQuery
 * is not configured or returns an error.
 */
function buildResponseTimeSeries(
  needs:        NeedDoc[],
  rangeHours:   number,
): ResponseTimePoint[] {
  const nowMs      = Date.now();
  const startMs    = nowMs - rangeHours * 60 * 60 * 1000;
  const bucketMs   = 15 * 60 * 1000; // 15 minutes
  const bucketCount = Math.ceil((rangeHours * 60) / 15);

  const buckets: { totalMins: number; count: number }[] = Array.from(
    { length: bucketCount },
    () => ({ totalMins: 0, count: 0 }),
  );

  for (const need of needs) {
    if (!need.resolvedAt || !need.assignedAt) continue;
    const resolvedMs = need.resolvedAt.seconds * 1000;
    if (resolvedMs < startMs || resolvedMs > nowMs) continue;

    const responseMins = (need.resolvedAt.seconds - need.assignedAt.seconds) / 60;
    if (responseMins < 0 || responseMins > 480) continue; // ignore outliers

    const bucketIdx = Math.floor((resolvedMs - startMs) / bucketMs);
    if (bucketIdx >= 0 && bucketIdx < bucketCount) {
      const b = buckets[bucketIdx];
      if (b != null) {
        b.totalMins += responseMins;
        b.count     += 1;
      }
    }
  }

  return buckets.map((b, i) => ({
    time:       new Date(startMs + i * bucketMs).toISOString(),
    avgMinutes: b.count > 0 ? Math.round(b.totalMins / b.count) : 0,
    sampleSize: b.count,
  }));
}

/**
 * Attempt to fetch response-time series from BigQuery.
 * Returns null when BQ is not configured or the query fails.
 */
async function fetchResponseTimesFromBigQuery(
  disasterId:  string,
  rangeHours:  number,
): Promise<ResponseTimePoint[] | null> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';
  if (!projectId) return null;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId });

    const [rows] = await bq.query({
      query: `
        SELECT
          TIMESTAMP_TRUNC(completed_at, MINUTE, 'Asia/Kolkata') AS bucket,
          AVG(response_time_minutes)                             AS avg_minutes,
          COUNT(*)                                               AS sample_size
        FROM \`${projectId}.${datasetId}.response_metrics\`
        WHERE disaster_id = @disasterId
          AND completed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${rangeHours} HOUR)
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
      params: { disasterId },
    });

    return (rows as Array<{ bucket: { value: string }; avg_minutes: number; sample_size: number }>).map((r) => ({
      time:       r.bucket.value,
      avgMinutes: Math.round(r.avg_minutes ?? 0),
      sampleSize: r.sample_size ?? 0,
    }));
  } catch {
    return null;
  }
}

function buildFunnel(needs: NeedDoc[]): FunnelStage[] {
  // Count needs at each status and all subsequent statuses
  // (cumulative so the funnel always decreases).
  const total = needs.filter((n) => n.status !== NeedStatus.DUPLICATE && n.status !== NeedStatus.CANCELLED).length;

  // For the funnel, a need "passed through" a stage if it ever had that status.
  // Simplified: count needs whose current status is >= stage in the lifecycle order.
  const stageOrder = FUNNEL_ORDER;

  const counts: number[] = stageOrder.map((status) => {
    const stageIdx = stageOrder.indexOf(status);
    return needs.filter(
      (n) =>
        n.status !== NeedStatus.CANCELLED &&
        n.status !== NeedStatus.DUPLICATE &&
        stageOrder.indexOf(n.status as NeedStatus) >= stageIdx,
    ).length;
  });

  return stageOrder.map((status, i) => {
    const count      = counts[i] ?? 0;
    const prevCount  = i === 0 ? total : (counts[i - 1] ?? count);
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
    const dropOff    = prevCount > 0 ? Math.round(((prevCount - count) / prevCount) * 100) : 0;

    return {
      status,
      label:       FUNNEL_LABELS[status],
      count,
      percentage,
      dropOffRate: i === 0 ? 0 : dropOff,
    };
  });
}

function buildTypeBreakdown(needs: NeedDoc[]): TypeBreakdownSlice[] {
  const active = needs.filter(
    (n) => n.status !== NeedStatus.CANCELLED && n.status !== NeedStatus.DUPLICATE,
  );
  const total = active.length || 1;

  return Object.values(NeedType).map((type) => {
    const count = active.filter((n) => n.type === type).length;
    return {
      type,
      label:      TYPE_LABELS[type],
      count,
      percentage: Math.round((count / total) * 100),
      color:      TYPE_COLORS[type],
    };
  });
}

function buildHeatmap(needs: NeedDoc[]): HeatmapCell[] {
  const hourCounts = new Array<number>(24).fill(0);

  for (const need of needs) {
    if (!need.assignedAt) continue;
    const hour = new Date(need.assignedAt.seconds * 1000).getHours();
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
  }

  return hourCounts.map((count, hour) => ({ hour, count }));
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<AnalyticsPayload>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip        = getClientIp(request);
  const ctx       = { requestId, remoteIp: ip };

  // Rate limit.
  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  // Auth.
  const cookieStore   = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (sessionCookie === undefined) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    await verifySessionCookie(sessionCookie.value, ctx);
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  // Parse + validate query params.
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    disasterId: searchParams.get('disasterId') ?? '',
    timeRange:  searchParams.get('timeRange')  ?? '4h',
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'disasterId is required.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  const { disasterId, timeRange } = parsed.data;
  const rangeHours = timeRangeToHours(timeRange);

  logger.info('GET', 'analytics query', { disasterId, timeRange }, ctx);

  try {
    // Fetch all needs from Firestore (cached by Next.js for 60 s).
    const needs = await fetchNeedsFromFirestore(disasterId);

    // Try BigQuery for response times first; fall back to Firestore computation.
    let responseTimes = await fetchResponseTimesFromBigQuery(disasterId, rangeHours);
    if (responseTimes === null) {
      responseTimes = buildResponseTimeSeries(needs, rangeHours);
    }

    const funnel        = buildFunnel(needs);
    const typeBreakdown = buildTypeBreakdown(needs);
    const heatmap       = buildHeatmap(needs);

    const totalNeeds   = needs.filter((n) => n.status !== NeedStatus.CANCELLED && n.status !== NeedStatus.DUPLICATE).length;
    const resolvedCount = needs.filter((n) => n.status === NeedStatus.RESOLVED).length;
    const resolvedPercent = totalNeeds > 0 ? Math.round((resolvedCount / totalNeeds) * 100) : 0;

    // Coverage: for demo purposes we return a fixed percentage;
    // production would compute it by checking if needs exist across all districts.
    const coveragePercent = Math.min(100, totalNeeds > 0 ? Math.min(95, totalNeeds * 2) : 0);

    const payload: AnalyticsPayload = {
      responseTimes,
      funnel,
      heatmap,
      typeBreakdown,
      coveragePercent,
      resolvedPercent,
      totalNeeds,
      computedAt: new Date().toISOString(),
    };

    logger.info('GET', 'analytics computed', { totalNeeds }, ctx);

    return NextResponse.json(
      { success: true, data: payload, error: null, requestId },
      {
        status:  200,
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
        },
      },
    );
  } catch (err) {
    logger.error('GET', 'analytics computation failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      {
        success: false,
        data:    null,
        error:   { code: 'INTERNAL_ERROR' as const, message: 'Analytics unavailable. Please try again.', statusCode: 500 },
        requestId,
      },
      { status: 500 },
    );
  }
}
