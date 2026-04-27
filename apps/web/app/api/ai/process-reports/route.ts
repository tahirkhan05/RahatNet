/**
 * POST /api/ai/process-reports
 *
 * Runs the full Gemini AI de-duplication pipeline on pending raw reports.
 *
 * Pipeline:
 *   1. Auth check — coordinator or admin only.
 *   2. Fetch PENDING raw reports from Firestore (all or specific IDs).
 *   3. Chunk into batches of 50 to avoid Firestore read limits.
 *   4. For each batch:
 *      a. clusterByGPS  → RawReportCluster[]
 *      b. deduplicateCluster (Gemini NLP) → sub-clusters
 *      c. generateCanonicalNeed (Gemini) → CanonicalNeed document
 *      d. scoreUrgency (Gemini Vision + keywords + context)
 *      e. Write CanonicalNeed to /needs/{id}
 *      f. Update source RawReports status → PROCESSED or DUPLICATE
 *      g. Publish to RTDB live feed
 *   5. Save Gemini audit responses to /aiAuditLog/{batchId}/{clusterId}
 *   6. Log token usage to BigQuery (best-effort, non-blocking).
 *   7. Return { processed, canonical, duplicatesRemoved, timing }.
 *
 * Error isolation:
 *   If one cluster fails, the error is logged and processing continues.
 *   Failed clusters are NOT marked as PROCESSED — they remain PENDING
 *   so the next run picks them up.
 *
 * Rate limiting:
 *   The in-process Gemini rate limiter (60 calls/min) in lib/ai/gemini.ts
 *   handles the Google API limit.  This route has its own per-IP limit
 *   (5 calls/min) to prevent multiple coordinators triggering concurrent runs.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { NeedStatus, COLLECTIONS } from '@rahatnet/types';
import type { RawReport, CanonicalNeed, ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';
import {
  clusterByGPS,
  deduplicateCluster,
  generateCanonicalNeed,
  scoreUrgency,
  urgencyToSeverity,
  type RawReportCluster,
} from '@/lib/ai/deduplication';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

/** Maximum raw reports fetched in a single API call. */
const MAX_REPORTS_PER_CALL = 500;

/** Chunk size for GPS clustering (keeps memory footprint bounded). */
const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// Module singletons
// ---------------------------------------------------------------------------

const logger  = createServerLogger('ai-process-reports');
const limiter  = createRateLimiter({ limit: 5, windowMs: 60_000, prefix: 'ai-process' });

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const bodySchema = z.object({
  /** Arbitrary ID to correlate this run in audit logs (UUID recommended). */
  batchId: z.string().min(1).max(128),
  /**
   * Optional: process only these report IDs.
   * When absent, all PENDING reports in the active disaster event are processed.
   */
  reportIds: z.array(z.string()).max(MAX_REPORTS_PER_CALL).optional(),
  /**
   * The disaster event scope.
   * Required when reportIds is not provided (to scope the Firestore query).
   */
  disasterEventId: z.string().min(1).optional(),
});

type ProcessReportsBody = z.infer<typeof bodySchema>;

// ---------------------------------------------------------------------------
// Pipeline result types
// ---------------------------------------------------------------------------

interface ClusterResult {
  readonly needId:           string;
  readonly sourceReportIds:  readonly string[];
  readonly duplicateIds:     readonly string[];
  readonly tokensUsed:       number;
  readonly success:          boolean;
  readonly error?:           string;
}

export interface ProcessReportsResponse {
  readonly batchId:           string;
  readonly processed:         number;
  readonly canonical:         number;
  readonly duplicatesRemoved: number;
  readonly failedClusters:    number;
  readonly totalTokensUsed:   number;
  readonly timing:            number;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<ProcessReportsResponse>>> {
  const startMs    = Date.now();
  const requestId  = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip         = getClientIp(request);
  const ctx        = { requestId, remoteIp: ip };

  // 1. Rate limit — prevents concurrent runs from different coordinators.
  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  // 2. Auth — coordinator or admin only.
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (sessionCookie === undefined) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  let uid: string;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    uid = decoded.uid;

    // Role check: only coordinators and admins can trigger AI processing.
    const role = decoded['role'] as string | undefined;
    if (role !== 'COORDINATOR' && role !== 'ADMIN') {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Coordinator or Admin role required.', statusCode: 403 }, requestId },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  // 3. Parse and validate body.
  let body: ProcessReportsBody;
  try {
    const raw: unknown = await request.json();
    body = bodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid request body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  const { batchId, reportIds, disasterEventId } = body;

  logger.info('POST', 'pipeline started', {
    batchId,
    reportIds: reportIds?.length ?? 'all',
    disasterEventId: disasterEventId ?? '(not specified)',
    triggeredBy: uid,
  }, ctx);

  // 4. Fetch raw reports from Firestore.
  const { adminFirestore } = await import('@/lib/firebase/admin');
  const { FieldValue }     = await import('firebase-admin/firestore');

  let rawReports: RawReport[];
  try {
    rawReports = await fetchPendingReports(adminFirestore, reportIds, disasterEventId);
  } catch (err) {
    logger.error('POST', 'failed to fetch reports', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'FIRESTORE_ERROR' as const, message: 'Failed to fetch pending reports.', statusCode: 503 }, requestId },
      { status: 503 },
    );
  }

  if (rawReports.length === 0) {
    return NextResponse.json({
      success: true,
      data: { batchId, processed: 0, canonical: 0, duplicatesRemoved: 0, failedClusters: 0, totalTokensUsed: 0, timing: Date.now() - startMs },
      error:  null,
      requestId,
    });
  }

  logger.info('POST', `processing ${rawReports.length} reports`, { batchId }, ctx);

  // 5. Mark all fetched reports as AI_PROCESSING to prevent concurrent runs.
  await markAsProcessing(adminFirestore, FieldValue, rawReports.map((r) => r.id));

  // 6. Run the pipeline in chunks of BATCH_SIZE.
  let totalCanonical      = 0;
  let totalDuplicates     = 0;
  let totalFailedClusters = 0;
  let totalTokensUsed     = 0;

  const auditLog: Array<{
    clusterId:    string;
    reportIds:    readonly string[];
    dedupeResponse:    string;
    canonicalResponse: string;
    tokensUsed:   number;
    error?:       string;
  }> = [];

  for (let offset = 0; offset < rawReports.length; offset += BATCH_SIZE) {
    const chunk   = rawReports.slice(offset, offset + BATCH_SIZE);
    const results = await processChunk({
      chunk,
      batchId,
      disasterEventId: disasterEventId ?? 'unknown',
      adminFirestore,
      FieldValue,
      ctx,
    });

    for (const r of results) {
      totalTokensUsed += r.tokensUsed;
      if (r.success) {
        totalCanonical++;
        totalDuplicates += r.duplicateIds.length;
        auditLog.push({
          clusterId:         r.needId,
          reportIds:         r.sourceReportIds,
          dedupeResponse:    '(stored in need document)',
          canonicalResponse: '(stored in need document)',
          tokensUsed:        r.tokensUsed,
        });
      } else {
        totalFailedClusters++;
        logger.warn(
          'POST',
          `cluster failed — reports left as PENDING`,
          { name: 'ClusterError', message: r.error ?? 'unknown' },
          { reportIds: r.sourceReportIds },
          ctx,
        );
        // Revert the AI_PROCESSING status for failed reports.
        await revertToProcessing(adminFirestore, FieldValue, r.sourceReportIds);
      }
    }
  }

  // 7. Write the audit log to Firestore (best-effort).
  void writeAuditLog(adminFirestore, batchId, auditLog).catch((err: unknown) => {
    logger.warn('POST', 'audit log write failed', toLogError(err), undefined, ctx);
  });

  // 8. Log token usage to BigQuery (best-effort, fire-and-forget).
  void logTokenUsageToBigQuery({
    batchId,
    reportCount:   rawReports.length,
    canonical:     totalCanonical,
    duplicates:    totalDuplicates,
    tokensUsed:    totalTokensUsed,
    durationMs:    Date.now() - startMs,
    triggeredBy:   uid,
  }).catch((err: unknown) => {
    logger.warn('POST', 'BigQuery cost log failed', toLogError(err), undefined, ctx);
  });

  const timing = Date.now() - startMs;

  logger.info('POST', 'pipeline complete', {
    batchId,
    processed:   rawReports.length,
    canonical:   totalCanonical,
    duplicates:  totalDuplicates,
    failed:      totalFailedClusters,
    tokens:      totalTokensUsed,
    timing,
  }, ctx);

  return NextResponse.json({
    success: true,
    data: {
      batchId,
      processed:         rawReports.length,
      canonical:         totalCanonical,
      duplicatesRemoved: totalDuplicates,
      failedClusters:    totalFailedClusters,
      totalTokensUsed,
      timing,
    },
    error:     null,
    requestId,
  });
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

async function fetchPendingReports(
  db:              FirebaseFirestore.Firestore,
  reportIds?:      readonly string[],
  disasterEventId?: string,
): Promise<RawReport[]> {
  const reports: RawReport[] = [];

  if (reportIds !== undefined && reportIds.length > 0) {
    // Fetch specific report IDs (in batches of 30 — Firestore `in` limit).
    const IN_LIMIT = 30;
    for (let i = 0; i < reportIds.length; i += IN_LIMIT) {
      const batch = reportIds.slice(i, i + IN_LIMIT);
      const snap  = await db
        .collection(COLLECTIONS.RAW_REPORTS)
        .where('__name__', 'in', batch)
        .where('status', '==', 'PENDING')
        .get();
      for (const doc of snap.docs) {
        reports.push({ id: doc.id, ...doc.data() } as RawReport);
      }
    }
  } else {
    // Fetch all PENDING reports, optionally scoped to a disaster event.
    let query: FirebaseFirestore.Query = db
      .collection(COLLECTIONS.RAW_REPORTS)
      .where('status', '==', 'PENDING')
      .orderBy('createdAt', 'asc')
      .limit(MAX_REPORTS_PER_CALL);

    if (disasterEventId !== undefined) {
      query = query.where('disasterEventId', '==', disasterEventId);
    }

    const snap = await query.get();
    for (const doc of snap.docs) {
      reports.push({ id: doc.id, ...doc.data() } as RawReport);
    }
  }

  return reports;
}

async function markAsProcessing(
  db:         FirebaseFirestore.Firestore,
  FieldValue: typeof import('firebase-admin/firestore').FieldValue,
  ids:        readonly string[],
): Promise<void> {
  const BATCH_LIMIT = 500;
  for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + BATCH_LIMIT)) {
      batch.update(db.collection(COLLECTIONS.RAW_REPORTS).doc(id), {
        status:    'AI_PROCESSING',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

async function revertToProcessing(
  db:         FirebaseFirestore.Firestore,
  FieldValue: typeof import('firebase-admin/firestore').FieldValue,
  ids:        readonly string[],
): Promise<void> {
  const batch = db.batch();
  for (const id of ids) {
    batch.update(db.collection(COLLECTIONS.RAW_REPORTS).doc(id), {
      status: 'PENDING',
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

/**
 * Process one chunk of raw reports through the full pipeline.
 * Error isolation: a thrown error inside a cluster is caught and returned
 * as a failed result — processing continues with the next cluster.
 */
async function processChunk(params: {
  chunk:           readonly RawReport[];
  batchId:         string;
  disasterEventId: string;
  adminFirestore:  FirebaseFirestore.Firestore;
  FieldValue:      typeof import('firebase-admin/firestore').FieldValue;
  ctx:             { requestId?: string };
}): Promise<ClusterResult[]> {
  const { chunk, batchId, disasterEventId, adminFirestore, FieldValue, ctx } = params;

  // Phase 1: GPS clustering.
  const gpsClusters = clusterByGPS(chunk);

  const results: ClusterResult[] = [];

  for (const gpsCluster of gpsClusters) {
    try {
      const clusterResults = await processOneGpsCluster({
        gpsCluster,
        batchId,
        disasterEventId,
        adminFirestore,
        FieldValue,
        ctx,
      });
      results.push(...clusterResults);
    } catch (err) {
      // Error isolation — log and continue.
      logger.error(
        'processChunk',
        'cluster processing failed',
        toLogError(err),
        { reportIds: gpsCluster.reports.map((r) => r.id) },
        ctx,
      );
      results.push({
        needId:          'failed',
        sourceReportIds: gpsCluster.reports.map((r) => r.id),
        duplicateIds:    [],
        tokensUsed:      0,
        success:         false,
        error:           err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Run the full pipeline for a single GPS cluster (phases 2–4 + Firestore writes).
 * Returns one ClusterResult per final sub-cluster.
 */
async function processOneGpsCluster(params: {
  gpsCluster:      RawReportCluster;
  batchId:         string;
  disasterEventId: string;
  adminFirestore:  FirebaseFirestore.Firestore;
  FieldValue:      typeof import('firebase-admin/firestore').FieldValue;
  ctx:             { requestId?: string };
}): Promise<ClusterResult[]> {
  const { gpsCluster, disasterEventId, adminFirestore, FieldValue, ctx } = params;

  // Phase 2: NLP de-duplication.
  const dedupeResults = await deduplicateCluster(gpsCluster);

  const clusterResults: ClusterResult[] = [];

  for (const { cluster, confidence, rawResponse: dedupeRawResponse } of dedupeResults) {
    let totalTokens  = 0;
    const needId     = crypto.randomUUID();

    // Phase 3: Generate canonical need.
    const { need, rawResponse: canonicalRawResponse, tokensUsed: canonTokens } =
      await generateCanonicalNeed(cluster, needId, confidence, disasterEventId);
    totalTokens += canonTokens;

    // Phase 4: Score urgency.
    const allDescriptions = cluster.reports.map((r) => r.description);
    const allPhotos       = cluster.reports.flatMap((r) => r.photoUrls as string[]);

    const urgencyResult = await scoreUrgency(
      allDescriptions,
      allPhotos,
      need.affectedCount,
      need.hasVulnerable,
      need.reportCount,
    );
    totalTokens += urgencyResult.totalTokens;

    // Override the urgency score from the scoring function.
    const finalNeed: CanonicalNeed = {
      ...(need as Omit<CanonicalNeed, 'createdAt' | 'updatedAt'>),
      urgencyScore: urgencyResult.urgencyScore,
      severity:     urgencyToSeverity(urgencyResult.urgencyScore),
      aiProcessingMeta: {
        ...need.aiProcessingMeta,
        urgencyFactors: {
          keyword:     urgencyResult.keywordScore,
          photo:       urgencyResult.photoScore,
          context:     urgencyResult.contextScore,
        },
      },
      // These will be set by FieldValue.serverTimestamp() below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createdAt: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedAt: null as any,
    };

    // Write CanonicalNeed to Firestore.
    await adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId).set({
      ...finalNeed,
      // Embed the raw Gemini responses for the audit trail.
      _auditDedupeResponse:    dedupeRawResponse,
      _auditCanonicalResponse: canonicalRawResponse,
      _auditBatchId:           params.batchId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Update source reports status.
    const primaryReportIds: string[]   = [];
    const duplicateReportIds: string[] = [];

    cluster.reports.forEach((r, idx) => {
      if (idx === 0) primaryReportIds.push(r.id);
      else           duplicateReportIds.push(r.id);
    });

    await updateSourceReports({
      adminFirestore,
      FieldValue,
      primaryIds:   primaryReportIds,
      duplicateIds: duplicateReportIds,
      needId,
    });

    // Publish to RTDB live feed (best-effort).
    void publishToRtdb(finalNeed).catch((err: unknown) => {
      logger.warn('processOneGpsCluster', 'RTDB publish failed', toLogError(err), undefined, ctx);
    });

    clusterResults.push({
      needId,
      sourceReportIds:  cluster.reports.map((r) => r.id),
      duplicateIds:     duplicateReportIds,
      tokensUsed:       totalTokens,
      success:          true,
    });
  }

  return clusterResults;
}

async function updateSourceReports(params: {
  adminFirestore:  FirebaseFirestore.Firestore;
  FieldValue:      typeof import('firebase-admin/firestore').FieldValue;
  primaryIds:      readonly string[];
  duplicateIds:    readonly string[];
  needId:          string;
}): Promise<void> {
  const { adminFirestore, FieldValue, primaryIds, duplicateIds, needId } = params;
  const BATCH_LIMIT = 500;

  // Mark primary reports as PROCESSED.
  for (let i = 0; i < primaryIds.length; i += BATCH_LIMIT) {
    const batch = adminFirestore.batch();
    for (const id of primaryIds.slice(i, i + BATCH_LIMIT)) {
      batch.update(adminFirestore.collection(COLLECTIONS.RAW_REPORTS).doc(id), {
        status:          'PROCESSED',
        canonicalNeedId: needId,
        updatedAt:       FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  // Mark duplicate reports as DUPLICATE.
  for (let i = 0; i < duplicateIds.length; i += BATCH_LIMIT) {
    const batch = adminFirestore.batch();
    for (const id of duplicateIds.slice(i, i + BATCH_LIMIT)) {
      batch.update(adminFirestore.collection(COLLECTIONS.RAW_REPORTS).doc(id), {
        status:          'DUPLICATE',
        canonicalNeedId: needId,
        updatedAt:       FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
}

async function publishToRtdb(need: CanonicalNeed): Promise<void> {
  const { getDatabase } = await import('firebase-admin/database');
  const db = getDatabase();
  await db.ref(`liveNeedsFeed/${need.id}`).set({
    title:        need.title,
    type:         need.type,
    severity:     need.severity,
    urgencyScore: need.urgencyScore,
    status:       need.status,
    lat:          need.location.lat,
    lng:          need.location.lng,
    updatedAt:    Date.now(),
  });
}

async function writeAuditLog(
  db:      FirebaseFirestore.Firestore,
  batchId: string,
  entries: ReadonlyArray<{
    clusterId:         string;
    reportIds:         readonly string[];
    dedupeResponse:    string;
    canonicalResponse: string;
    tokensUsed:        number;
    error?:            string;
  }>,
): Promise<void> {
  if (entries.length === 0) return;

  const batchRef = db.collection('aiAuditLog').doc(batchId);
  const BATCH_LIMIT = 20; // Firestore doc size limit per batch

  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const entry of entries.slice(i, i + BATCH_LIMIT)) {
      batch.set(batchRef.collection('clusters').doc(entry.clusterId), {
        reportIds:         entry.reportIds,
        dedupeResponse:    entry.dedupeResponse,
        canonicalResponse: entry.canonicalResponse,
        tokensUsed:        entry.tokensUsed,
        error:             entry.error ?? null,
        processedAt:       new Date().toISOString(),
      });
    }
    await batch.commit();
  }
}

async function logTokenUsageToBigQuery(params: {
  batchId:     string;
  reportCount: number;
  canonical:   number;
  duplicates:  number;
  tokensUsed:  number;
  durationMs:  number;
  triggeredBy: string;
}): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';

  if (projectId == null || projectId === '') return; // BigQuery not configured.

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    const bq = new BigQuery({ projectId });

    await bq.dataset(datasetId).table('ai_token_usage').insert([
      {
        batch_id:      params.batchId,
        report_count:  params.reportCount,
        canonical:     params.canonical,
        duplicates:    params.duplicates,
        tokens_used:   params.tokensUsed,
        duration_ms:   params.durationMs,
        triggered_by:  params.triggeredBy,
        model:         'gemini-1.5-flash',
        processed_at:  new Date().toISOString(),
      },
    ]);
  } catch {
    // BigQuery logging is best-effort — never throw.
  }
}
