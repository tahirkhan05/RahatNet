/**
 * POST /api/dispatch
 *
 * Assigns a volunteer to a canonical need.  Used by:
 *   - War-room coordinators (manual selection)
 *   - Auto-dispatch (autoSelect: true — algorithm picks the best available)
 *
 * Pipeline:
 *   1. Verify coordinator/admin session.
 *   2. Validate body with Zod.
 *   3. Per-need rate limit: max 1 dispatch per need per 5 minutes.
 *   4. Fetch canonical need from Firestore; verify status === VERIFIED.
 *   5. If autoSelect, call findBestVolunteers() and pick #1.
 *   6. Verify target volunteer exists and is AVAILABLE.
 *   7. Atomic Firestore transaction:
 *        a. Create /assignments/{id} with status CREATED.
 *        b. Update /needs/{id} status → ASSIGNED, assignedVolunteerId.
 *   8. Send FCM push notification to the volunteer.
 *   9. Update RTDB /liveNeedsFeed to reflect the new status.
 *  10. Log dispatch event + score breakdown to BigQuery.
 *  11. Schedule a 60-second auto-reassign via an in-process timer.
 *      If the volunteer doesn't accept within 60 s, PATCH the assignment to
 *      DECLINED (TIMEOUT reason) and re-dispatch to candidate #2.
 *
 * Return:
 *   { assignmentId, volunteerId, volunteerName, estimatedArrivalMinutes }
 *
 * Rate limiting:
 *   Per-IP: 20 req/min (prevents coordinator from spamming the button).
 *   Per-need: 1 dispatch per 5 min (prevents rapid reassignment churn).
 *
 * Firestore transaction guarantee:
 *   The assignment creation and need status update are atomic.  If either
 *   fails, neither is committed — the need stays VERIFIED and the volunteer
 *   is not notified.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  NeedStatus,
  AssignmentStatus,
  COLLECTIONS,
  type CanonicalNeed,
  type VolunteerProfile,
} from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';
import { findBestVolunteers } from '@/lib/ai/dispatch';
import type { VolunteerMatch } from '@/lib/ai/dispatch';

// ---------------------------------------------------------------------------
// Module singletons
// ---------------------------------------------------------------------------

const logger = createServerLogger('dispatch');
const ipLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'dispatch-ip' });

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

// ---------------------------------------------------------------------------
// Per-need rate limiter (in-process TTL map)
// ---------------------------------------------------------------------------

/** Tracks last dispatch time per needId. */
const needLastDispatch = new Map<string, number>();
const NEED_DISPATCH_COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

function needIsOnCooldown(needId: string): boolean {
  const last = needLastDispatch.get(needId);
  if (last === undefined) return false;
  return Date.now() - last < NEED_DISPATCH_COOLDOWN_MS;
}

function recordNeedDispatch(needId: string): void {
  // Bound map to 1000 entries.
  if (needLastDispatch.size >= 1_000) {
    const firstKey = needLastDispatch.keys().next().value;
    if (firstKey !== undefined) needLastDispatch.delete(firstKey);
  }
  needLastDispatch.set(needId, Date.now());
}

// ---------------------------------------------------------------------------
// Auto-reassign timer
// ---------------------------------------------------------------------------

import { pendingTimers, pendingCandidates } from './autoReassign';

function scheduleAutoReassign(
  assignmentId: string,
  needId: string,
  candidates: VolunteerMatch[],
  requestId: string,
): void {
  if (pendingTimers.has(assignmentId)) return; // Already scheduled.

  pendingCandidates.set(assignmentId, candidates);

  // 24 hours in dev — production should use a shorter window (e.g. 5 minutes)
  const timeoutMs = process.env.NODE_ENV === 'development' ? 24 * 60 * 60 * 1_000 : 5 * 60 * 1_000;
  const timerId = setTimeout(() => {
    void triggerAutoReassign(assignmentId, needId, requestId);
  }, timeoutMs);

  pendingTimers.set(assignmentId, timerId);
}

async function triggerAutoReassign(
  assignmentId: string,
  needId: string,
  requestId: string,
): Promise<void> {
  const candidates = pendingCandidates.get(assignmentId);
  pendingTimers.delete(assignmentId);
  pendingCandidates.delete(assignmentId);

  const ctx = { requestId };

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    // Check if the assignment was already accepted (volunteer responded in time).
    const assignSnap = await adminFirestore
      .collection(COLLECTIONS.ASSIGNMENTS)
      .doc(assignmentId)
      .get();
    if (!assignSnap.exists) return;

    const assignment = assignSnap.data() as { status: string };
    if (
      assignment.status === AssignmentStatus.ACCEPTED ||
      assignment.status === AssignmentStatus.IN_PROGRESS ||
      assignment.status === AssignmentStatus.COMPLETED
    ) {
      logger.info(
        'autoReassign',
        'volunteer accepted in time — skipping reassign',
        { assignmentId },
        ctx,
      );
      return;
    }

    // Mark current assignment as DECLINED with TIMEOUT reason.
    await adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId).update({
      status: AssignmentStatus.DECLINED,
      declinedReason: 'TIMEOUT',
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(
      'autoReassign',
      'assignment timed out — auto-declining',
      { assignmentId, needId },
      ctx,
    );

    // If there is a second candidate, dispatch to them.
    const nextCandidate = candidates?.[1];
    if (nextCandidate) {
      logger.info(
        'autoReassign',
        'dispatching to fallback candidate',
        {
          volunteerId: nextCandidate.uid,
          score: nextCandidate.scores.compositeScore,
        },
        ctx,
      );
      await performDispatch({
        needId,
        volunteerId: nextCandidate.uid,
        coordinatorId: 'SYSTEM_AUTO',
        message: `Please proceed to ${(await adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId).get()).data()?.locationName ?? 'the location'}.`,
        matchScore: nextCandidate.scores.compositeScore,
        matchFactors: {
          distanceScore: nextCandidate.scores.distanceScore,
          skillScore: nextCandidate.scores.skillScore,
          languageScore: nextCandidate.scores.languageScore,
          historyScore: nextCandidate.scores.historyScore,
          estimatedDrivingMinutes: nextCandidate.scores.estimatedDrivingMinutes,
        },
        allCandidates: candidates.slice(1), // shift the list so next timeout goes to candidate #3
        requestId,
      });
    } else {
      // No more candidates — revert the need to VERIFIED.
      await adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId).update({
        status: NeedStatus.VERIFIED,
        assignedVolunteerId: null,
        assignedAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      logger.warn(
        'autoReassign',
        'no more candidates — need reverted to VERIFIED',
        undefined,
        { needId },
        ctx,
      );
    }
  } catch (err) {
    logger.error(
      'autoReassign',
      'auto-reassign failed',
      toLogError(err),
      { assignmentId, needId },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Core dispatch logic (shared by POST and auto-reassign)
// ---------------------------------------------------------------------------

interface DispatchParams {
  needId: string;
  volunteerId: string;
  coordinatorId: string;
  message: string;
  matchScore: number;
  matchFactors: {
    distanceScore: number;
    skillScore: number;
    languageScore: number;
    historyScore: number;
    estimatedDrivingMinutes: number;
  };
  allCandidates: VolunteerMatch[];
  requestId: string;
}

interface DispatchResult {
  assignmentId: string;
  volunteerId: string;
  volunteerName: string;
  estimatedArrivalMinutes: number;
}

async function performDispatch(params: DispatchParams): Promise<DispatchResult> {
  const {
    needId,
    volunteerId,
    coordinatorId,
    message,
    matchScore,
    matchFactors,
    allCandidates,
    requestId,
  } = params;

  const ctx = { requestId, userId: coordinatorId };
  const { adminFirestore } = await import('@/lib/firebase/admin');
  const { FieldValue } = await import('firebase-admin/firestore');

  const assignmentId = crypto.randomUUID();

  // ── Atomic Firestore transaction: create assignment + update need ─────────
  await adminFirestore.runTransaction(async (tx) => {
    const needRef = adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId);
    const needSnap = await tx.get(needRef);

    if (!needSnap.exists) throw new Error(`Need ${needId} not found`);
    const need = needSnap.data() as CanonicalNeed;

    // Re-verify status inside the transaction (prevent double-dispatch).
    if (need.status !== NeedStatus.VERIFIED && need.status !== NeedStatus.PENDING) {
      throw new Error(`Need ${needId} is no longer available (status: ${need.status})`);
    }

    // Create the assignment document.
    const assignRef = adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId);
    tx.set(assignRef, {
      id: assignmentId,
      needId,
      volunteerId,
      coordinatorId,
      status: AssignmentStatus.CREATED,
      matchScore,
      matchFactors,
      message,
      notification: null,
      createdAt: FieldValue.serverTimestamp(),
      acceptedAt: null,
      arrivedAt: null,
      completedAt: null,
      declinedReason: null,
      declinedNote: null,
      metrics: null,
    });

    // Update need status.
    tx.update(needRef, {
      status: NeedStatus.ASSIGNED,
      assignedVolunteerId: volunteerId,
      assignedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  logger.info('performDispatch', 'assignment created', { assignmentId, volunteerId, needId }, ctx);

  // ── FCM push notification ─────────────────────────────────────────────────
  let volunteerName = volunteerId;
  let volunteerToken: string | null = null;

  try {
    const profileSnap = await adminFirestore.collection(COLLECTIONS.USERS).doc(volunteerId).get();

    if (profileSnap.exists) {
      const profile = profileSnap.data() as VolunteerProfile;
      volunteerName = profile.displayName;
      volunteerToken = profile.fcmToken ?? null;
    }
  } catch (err) {
    logger.warn(
      'performDispatch',
      'could not fetch volunteer profile for FCM',
      toLogError(err),
      undefined,
      ctx,
    );
  }

  if (volunteerToken) {
    try {
      const { adminMessaging } = await import('@/lib/firebase/admin');
      const needSnap = await adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId).get();
      const need = needSnap.data() as CanonicalNeed;

      await adminMessaging.send({
        token: volunteerToken,
        notification: {
          title: `New task: ${need.type}`,
          body: `${need.locationName} — ${need.affectedCount} people`,
        },
        data: {
          type: 'TASK_ASSIGNED',
          assignmentId,
          needId,
          needType: need.type,
          locationName: need.locationName,
          message,
          clickUrl: `/volunteer/tasks?assignment=${assignmentId}`,
        },
        android: { priority: 'high', notification: { channelId: 'tasks' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
      });

      // Mark as NOTIFIED.
      await adminFirestore
        .collection(COLLECTIONS.ASSIGNMENTS)
        .doc(assignmentId)
        .update({
          status: AssignmentStatus.NOTIFIED,
          notification: {
            fcmToken: volunteerToken,
            sentAt: new Date().toISOString(),
            delivered: true,
            messageId: null,
            errorMessage: null,
          },
          updatedAt: FieldValue.serverTimestamp(),
        });

      logger.info('performDispatch', 'FCM notification sent', { assignmentId, volunteerId }, ctx);
    } catch (err) {
      logger.warn('performDispatch', 'FCM send failed', toLogError(err), { assignmentId }, ctx);
      // FCM failure is non-fatal — the assignment is created; coordinator can reassign.
    }
  }

  // ── RTDB feed update ──────────────────────────────────────────────────────
  try {
    const { getDatabase } = await import('firebase-admin/database');
    const db = getDatabase();
    await db.ref(`liveNeedsFeed/${needId}`).update({
      status: NeedStatus.ASSIGNED,
      updatedAt: Date.now(),
    });
  } catch (err) {
    logger.warn('performDispatch', 'RTDB update failed', toLogError(err), undefined, ctx);
  }

  // ── BigQuery audit log ────────────────────────────────────────────────────
  void logDispatchToBigQuery({
    assignmentId,
    needId,
    volunteerId,
    coordinatorId,
    matchScore,
    matchFactors,
    allCandidates,
    requestId,
  });

  // ── Dispatch audit log to Firestore ──────────────────────────────────────
  void (async () => {
    try {
      const { FieldValue: FV } = await import('firebase-admin/firestore');
      await adminFirestore.collection('dispatchAuditLog').add({
        assignmentId,
        needId,
        volunteerId,
        coordinatorId,
        matchScore,
        matchFactors,
        candidateCount: allCandidates.length,
        allCandidateScores: allCandidates.map((c) => ({
          uid: c.uid,
          score: c.scores.compositeScore,
        })),
        dispatchedAt: FV.serverTimestamp(),
      });
    } catch {
      // Non-fatal.
    }
  })();

  // ── 60-second auto-reassign timer ─────────────────────────────────────────
  scheduleAutoReassign(assignmentId, needId, allCandidates, requestId);

  return {
    assignmentId,
    volunteerId,
    volunteerName,
    estimatedArrivalMinutes: matchFactors.estimatedDrivingMinutes,
  };
}

// ---------------------------------------------------------------------------
// BigQuery logging (best-effort)
// ---------------------------------------------------------------------------

async function logDispatchToBigQuery(params: {
  assignmentId: string;
  needId: string;
  volunteerId: string;
  coordinatorId: string;
  matchScore: number;
  matchFactors: Record<string, number>;
  allCandidates: VolunteerMatch[];
  requestId: string;
}): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';
  if (!projectId) return;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    await new BigQuery({ projectId })
      .dataset(datasetId)
      .table('dispatch_events')
      .insert([
        {
          assignment_id: params.assignmentId,
          need_id: params.needId,
          volunteer_id: params.volunteerId,
          coordinator_id: params.coordinatorId,
          match_score: params.matchScore,
          distance_score: params.matchFactors['distanceScore'] ?? 0,
          skill_score: params.matchFactors['skillScore'] ?? 0,
          language_score: params.matchFactors['languageScore'] ?? 0,
          history_score: params.matchFactors['historyScore'] ?? 0,
          candidate_count: params.allCandidates.length,
          dispatched_at: new Date().toISOString(),
        },
      ]);
  } catch {
    // Never throw from BigQuery logging.
  }
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const postBodySchema = z
  .object({
    needId: z.string().min(1),
    volunteerId: z.string().optional(),
    autoSelect: z.boolean().default(false),
    message: z.string().max(500).optional(),
  })
  .refine(
    (data) => data.autoSelect || (data.volunteerId !== undefined && data.volunteerId.length > 0),
    { message: 'Either autoSelect must be true or volunteerId must be provided.' },
  );

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

interface PostDispatchResponse {
  assignmentId: string;
  volunteerId: string;
  volunteerName: string;
  estimatedArrivalMinutes: number;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<PostDispatchResponse>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  // 1. IP rate limit.
  const rl = ipLimiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  // 2. Auth — coordinator or admin only.
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (sessionCookie === undefined) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 },
        requestId,
      },
      { status: 401 },
    );
  }

  let coordinatorId: string;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    coordinatorId = decoded.uid;

    const role = decoded['role'] as string | undefined;
    if (role !== 'COORDINATOR' && role !== 'ADMIN') {
      return NextResponse.json(
        {
          success: false,
          data: null,
          error: {
            code: 'FORBIDDEN' as const,
            message: 'Coordinator role required.',
            statusCode: 403,
          },
          requestId,
        },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 },
        requestId,
      },
      { status: 401 },
    );
  }

  // 3. Parse body.
  let body: z.infer<typeof postBodySchema>;
  try {
    const raw: unknown = await request.json();
    body = postBodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR' as const,
          message: 'Invalid request body.',
          statusCode: 400,
        },
        requestId,
      },
      { status: 400 },
    );
  }

  const { needId, autoSelect } = body;

  // 4. Per-need cooldown.
  if (needIsOnCooldown(needId)) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'RATE_LIMITED' as const,
          message: 'This need was dispatched recently. Please wait before reassigning.',
          statusCode: 429,
        },
        requestId,
      },
      { status: 429 },
    );
  }

  logger.info('POST', 'dispatch request', { needId, autoSelect, coordinatorId }, ctx);

  const { adminFirestore } = await import('@/lib/firebase/admin');

  // 5. Fetch and validate the need.
  const needSnap = await adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId).get();
  if (!needSnap.exists) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: { code: 'NOT_FOUND' as const, message: 'Need not found.', statusCode: 404 },
        requestId,
      },
      { status: 404 },
    );
  }
  const need = needSnap.data() as CanonicalNeed;

  // Allow re-dispatching ASSIGNED needs (coordinator manually reassigning)
  const dispatchableStatuses = [NeedStatus.VERIFIED, NeedStatus.PENDING, NeedStatus.ASSIGNED];
  if (!dispatchableStatuses.includes(need.status)) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'CONFLICT' as const,
          message: `Need is in status "${need.status}" and cannot be dispatched.`,
          statusCode: 409,
        },
        requestId,
      },
      { status: 409 },
    );
  }

  // 6. Determine target volunteer + candidates list.
  let targetVolunteerId: string;
  let allCandidates: VolunteerMatch[] = [];
  let matchScore = 100;
  let matchFactors = {
    distanceScore: 100,
    skillScore: 100,
    languageScore: 100,
    historyScore: 100,
    estimatedDrivingMinutes: 0,
  };

  if (autoSelect) {
    const matches = await findBestVolunteers(need, 3, ctx);
    if (matches.length === 0) {
      return NextResponse.json(
        {
          success: false,
          data: null,
          error: {
            code: 'NOT_FOUND' as const,
            message: 'No available volunteers found for this need.',
            statusCode: 404,
          },
          requestId,
        },
        { status: 404 },
      );
    }
    allCandidates = matches;
    const top = matches[0]!;
    targetVolunteerId = top.uid;
    matchScore = top.scores.compositeScore;
    matchFactors = {
      distanceScore: top.scores.distanceScore,
      skillScore: top.scores.skillScore,
      languageScore: top.scores.languageScore,
      historyScore: top.scores.historyScore,
      estimatedDrivingMinutes: top.scores.estimatedDrivingMinutes,
    };
  } else {
    targetVolunteerId = body.volunteerId!;
    // Compute scores for the manual pick so the audit log is accurate.
    const matches = await findBestVolunteers(need, 3, ctx);
    allCandidates = matches;
    const picked = matches.find((m) => m.uid === targetVolunteerId);
    if (picked) {
      matchScore = picked.scores.compositeScore;
      matchFactors = {
        distanceScore: picked.scores.distanceScore,
        skillScore: picked.scores.skillScore,
        languageScore: picked.scores.languageScore,
        historyScore: picked.scores.historyScore,
        estimatedDrivingMinutes: picked.scores.estimatedDrivingMinutes,
      };
    }
  }

  // 7. Verify target volunteer availability.
  const profileSnap = await adminFirestore
    .collection(COLLECTIONS.USERS)
    .doc(targetVolunteerId)
    .get();

  if (!profileSnap.exists) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: { code: 'NOT_FOUND' as const, message: 'Volunteer not found.', statusCode: 404 },
        requestId,
      },
      { status: 404 },
    );
  }

  const profile = profileSnap.data() as VolunteerProfile;
  if (!profile.isAvailable || profile.activeAssignmentId !== null) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'CONFLICT' as const,
          message: 'Volunteer is no longer available.',
          statusCode: 409,
        },
        requestId,
      },
      { status: 409 },
    );
  }

  // 8. Perform the dispatch.
  recordNeedDispatch(needId); // Record before dispatch to prevent race conditions.

  const message = body.message ?? `Please proceed to ${need.locationName}.`;

  try {
    const result = await performDispatch({
      needId,
      volunteerId: targetVolunteerId,
      coordinatorId,
      message,
      matchScore,
      matchFactors,
      allCandidates,
      requestId,
    });

    logger.info('POST', 'dispatch complete', { assignmentId: result.assignmentId }, ctx);

    return NextResponse.json(
      { success: true, data: result, error: null, requestId },
      { status: 201 },
    );
  } catch (err) {
    // Undo the cooldown record on failure so the coordinator can retry immediately.
    needLastDispatch.delete(needId);
    logger.error('POST', 'dispatch failed', toLogError(err), { needId, targetVolunteerId }, ctx);
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'INTERNAL_ERROR' as const,
          message: 'Dispatch failed. Please try again.',
          statusCode: 500,
        },
        requestId,
      },
      { status: 500 },
    );
  }
}
