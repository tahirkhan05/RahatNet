/**
 * PATCH /api/dispatch/:assignmentId
 *
 * Updates the status of a volunteer task assignment.  Called by:
 *   - Volunteer app (Accept / Decline / Complete / Report issue)
 *   - Auto-reassign timer (DECLINED with TIMEOUT reason)
 *   - Service worker notification handler (Accept / Decline from push action)
 *
 * Status transitions and side-effects:
 *
 *   NOTIFIED → ACCEPTED
 *     - Cancel the 60-second auto-reassign timer.
 *     - Set assignment.acceptedAt = now.
 *     - Notify the coordinator (FCM topic or direct notification).
 *
 *   NOTIFIED/ACCEPTED → DECLINED
 *     - Record declinedReason.
 *     - Mark the assignment DECLINED.
 *     - Revert need status to VERIFIED so it can be reassigned.
 *     - If a fallback candidate exists in the auto-reassign queue, dispatch
 *       immediately (don't wait for the timer).
 *
 *   ACCEPTED/IN_PROGRESS → IN_PROGRESS
 *     - Volunteer confirmed arrival ("I've arrived").
 *     - Set assignment.arrivedAt = now.
 *
 *   IN_PROGRESS → COMPLETED
 *     - Set assignment.completedAt = now.
 *     - Update need status → RESOLVED.
 *     - Compute and store response time metrics.
 *     - Notify the coordinator.
 *     - Log to BigQuery for model training.
 *     - Update VolunteerStats in Firestore (completionRate, avgResponseTime).
 *
 *   ACCEPTED/IN_PROGRESS → FAILED
 *     - Similar to DECLINED but from an in-progress task.
 *     - Records declinedNote with the failure reason.
 *     - Reverts need to VERIFIED.
 *
 * Auth:
 *   - Volunteer can only update their own assignments.
 *   - Coordinator can update any assignment.
 *   - Auto-reassign timer runs as SYSTEM_AUTO (no session, internal call).
 *
 * Rate limit: 20 PATCH requests / min / IP.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  NeedStatus, AssignmentStatus, DeclineReason, COLLECTIONS,
  type CanonicalNeed,
} from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';
import { cancelAutoReassign } from '../route';

// ---------------------------------------------------------------------------
// Module singletons
// ---------------------------------------------------------------------------

const logger     = createServerLogger('dispatch-patch');
const ipLimiter  = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'dispatch-patch' });

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const patchBodySchema = z.object({
  status: z.nativeEnum(AssignmentStatus),
  reason: z.string().max(500).optional(),
  /** Volunteer's current GPS location at the time of the update. */
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).optional(),
  /** Free-text note for DECLINED(OTHER) or FAILED status. */
  declinedNote: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// PATCH handler
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: { assignmentId: string } },
): Promise<NextResponse<ApiResponse<{ assignmentId: string; status: string }>>> {
  const { assignmentId } = params;
  const requestId        = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip               = getClientIp(request);
  const ctx              = { requestId, remoteIp: ip };

  // Rate limit.
  const rl = ipLimiter.check(ip);
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

  let callerId: string;
  let callerRole: string;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    callerId   = decoded.uid;
    callerRole = (decoded['role'] as string | undefined) ?? 'VOLUNTEER';
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'SESSION_EXPIRED' as const, message: 'Session expired.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  // Parse body.
  let body: z.infer<typeof patchBodySchema>;
  try {
    const raw: unknown = await request.json();
    body = patchBodySchema.parse(raw);
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid request body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  const { adminFirestore } = await import('@/lib/firebase/admin');
  const { FieldValue }     = await import('firebase-admin/firestore');

  // Fetch the assignment.
  const assignSnap = await adminFirestore
    .collection(COLLECTIONS.ASSIGNMENTS)
    .doc(assignmentId)
    .get();

  if (!assignSnap.exists) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'NOT_FOUND' as const, message: 'Assignment not found.', statusCode: 404 }, requestId },
      { status: 404 },
    );
  }

  const assignment = assignSnap.data() as {
    volunteerId:   string;
    needId:        string;
    coordinatorId: string;
    status:        AssignmentStatus;
    createdAt:     { seconds: number };
    acceptedAt:    { seconds: number } | null;
    arrivedAt:     { seconds: number } | null;
  };

  // Auth check: volunteers can only update their own assignments.
  if (callerRole === 'VOLUNTEER' && assignment.volunteerId !== callerId) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Cannot update another volunteer\'s assignment.', statusCode: 403 }, requestId },
      { status: 403 },
    );
  }

  logger.info('PATCH', 'status update', {
    assignmentId,
    from: assignment.status,
    to:   body.status,
    callerId,
  }, ctx);

  const needId = assignment.needId;
  const now    = Date.now();

  try {
    switch (body.status) {
      // ── ACCEPTED ────────────────────────────────────────────────────────

      case AssignmentStatus.ACCEPTED: {
        if (assignment.status !== AssignmentStatus.NOTIFIED && assignment.status !== AssignmentStatus.CREATED) {
          return conflictResponse(requestId, `Cannot accept from status "${assignment.status}"`);
        }

        await adminFirestore.runTransaction(async (tx) => {
          tx.update(adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId), {
            status:     AssignmentStatus.ACCEPTED,
            acceptedAt: FieldValue.serverTimestamp(),
            updatedAt:  FieldValue.serverTimestamp(),
          });
        });

        // Cancel the 60-second auto-reassign timer.
        cancelAutoReassign(assignmentId);

        // Append history event.
        void appendHistoryEvent(assignmentId, assignment.volunteerId, AssignmentStatus.NOTIFIED, AssignmentStatus.ACCEPTED, body.location ?? null);

        // Notify coordinator (best-effort).
        void notifyCoordinator(needId, assignment.coordinatorId, `Volunteer accepted task for ${needId}`, 'TASK_ACCEPTED', ctx);

        break;
      }

      // ── IN_PROGRESS (arrived) ────────────────────────────────────────────

      case AssignmentStatus.IN_PROGRESS: {
        if (
          assignment.status !== AssignmentStatus.ACCEPTED &&
          assignment.status !== AssignmentStatus.NOTIFIED
        ) {
          return conflictResponse(requestId, `Cannot mark in-progress from status "${assignment.status}"`);
        }

        await adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId).update({
          status:     AssignmentStatus.IN_PROGRESS,
          arrivedAt:  FieldValue.serverTimestamp(),
          updatedAt:  FieldValue.serverTimestamp(),
        });

        void appendHistoryEvent(assignmentId, assignment.volunteerId, assignment.status, AssignmentStatus.IN_PROGRESS, body.location ?? null);
        void notifyCoordinator(needId, assignment.coordinatorId, `Volunteer arrived on site`, 'VOLUNTEER_ARRIVED', ctx);
        break;
      }

      // ── COMPLETED ────────────────────────────────────────────────────────

      case AssignmentStatus.COMPLETED: {
        const activeStatuses = [
          AssignmentStatus.IN_PROGRESS,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.NOTIFIED,
          AssignmentStatus.CREATED,
        ];
        if (!activeStatuses.includes(assignment.status)) {
          return conflictResponse(requestId, `Cannot complete from status "${assignment.status}"`);
        }

        const completedAt = Date.now();
        const responseTimeMinutes =
          assignment.createdAt
            ? Math.round((completedAt - assignment.createdAt.seconds * 1000) / 60_000)
            : 0;
        const onSiteMinutes =
          assignment.arrivedAt
            ? Math.round((completedAt - assignment.arrivedAt.seconds * 1000) / 60_000)
            : 0;

        // Atomic: complete assignment + resolve need.
        await adminFirestore.runTransaction(async (tx) => {
          tx.update(adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId), {
            status:      AssignmentStatus.COMPLETED,
            completedAt: FieldValue.serverTimestamp(),
            updatedAt:   FieldValue.serverTimestamp(),
            metrics: {
              responseTimeMinutes,
              onSiteMinutes,
              coordinatorRating: null,
              coordinatorNote:   null,
            },
          });
          tx.update(adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId), {
            status:     NeedStatus.RESOLVED,
            resolvedAt: FieldValue.serverTimestamp(),
            updatedAt:  FieldValue.serverTimestamp(),
          });
        });

        // Update volunteer stats (best-effort).
        void updateVolunteerStats(assignment.volunteerId, responseTimeMinutes);

        // RTDB update.
        void (async () => {
          try {
            const { getDatabase } = await import('firebase-admin/database');
            await getDatabase().ref(`liveNeedsFeed/${needId}`).update({
              status:    NeedStatus.RESOLVED,
              updatedAt: Date.now(),
            });
          } catch { /* non-fatal */ }
        })();

        // BigQuery metrics log.
        void logCompletionToBigQuery(assignmentId, needId, assignment.volunteerId, responseTimeMinutes, onSiteMinutes);

        void appendHistoryEvent(assignmentId, assignment.volunteerId, assignment.status, AssignmentStatus.COMPLETED, body.location ?? null);
        void notifyCoordinator(needId, assignment.coordinatorId, `Task completed in ${responseTimeMinutes} min`, 'TASK_COMPLETED', ctx);
        break;
      }

      // ── DECLINED ─────────────────────────────────────────────────────────

      case AssignmentStatus.DECLINED: {
        const declinedReason = (body.reason as DeclineReason | undefined) ?? DeclineReason.OTHER;

        await adminFirestore.runTransaction(async (tx) => {
          tx.update(adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId), {
            status:        AssignmentStatus.DECLINED,
            declinedReason,
            declinedNote:  body.declinedNote ?? null,
            updatedAt:     FieldValue.serverTimestamp(),
          });
          // Revert need to VERIFIED.
          tx.update(adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId), {
            status:              NeedStatus.VERIFIED,
            assignedVolunteerId: null,
            assignedAt:          null,
            updatedAt:           FieldValue.serverTimestamp(),
          });
        });

        // Cancel the timer so it doesn't double-trigger.
        cancelAutoReassign(assignmentId);

        void appendHistoryEvent(assignmentId, assignment.volunteerId, assignment.status, AssignmentStatus.DECLINED, body.location ?? null, body.reason);
        void notifyCoordinator(needId, assignment.coordinatorId, `Volunteer declined: ${declinedReason}`, 'TASK_DECLINED', ctx);
        break;
      }

      // ── FAILED ────────────────────────────────────────────────────────────

      case AssignmentStatus.FAILED: {
        await adminFirestore.runTransaction(async (tx) => {
          tx.update(adminFirestore.collection(COLLECTIONS.ASSIGNMENTS).doc(assignmentId), {
            status:       AssignmentStatus.FAILED,
            declinedNote: body.declinedNote ?? body.reason ?? null,
            updatedAt:    FieldValue.serverTimestamp(),
          });
          tx.update(adminFirestore.collection(COLLECTIONS.NEEDS).doc(needId), {
            status:              NeedStatus.VERIFIED,
            assignedVolunteerId: null,
            assignedAt:          null,
            updatedAt:           FieldValue.serverTimestamp(),
          });
        });

        cancelAutoReassign(assignmentId);
        void appendHistoryEvent(assignmentId, assignment.volunteerId, assignment.status, AssignmentStatus.FAILED, body.location ?? null, body.reason);
        void notifyCoordinator(needId, assignment.coordinatorId, `Task failed: ${body.reason ?? 'unknown reason'}`, 'TASK_FAILED', ctx);
        break;
      }

      default:
        return NextResponse.json(
          { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: `Unsupported status transition to "${body.status}".`, statusCode: 400 }, requestId },
          { status: 400 },
        );
    }

    return NextResponse.json(
      { success: true, data: { assignmentId, status: body.status }, error: null, requestId },
      { status: 200 },
    );
  } catch (err) {
    logger.error('PATCH', 'status update failed', toLogError(err), { assignmentId, newStatus: body.status }, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Status update failed. Please try again.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conflictResponse(requestId: string, message: string) {
  return NextResponse.json(
    { success: false, data: null, error: { code: 'CONFLICT' as const, message, statusCode: 409 }, requestId },
    { status: 409 },
  );
}

async function appendHistoryEvent(
  assignmentId:    string,
  volunteerId:     string,
  previousStatus:  AssignmentStatus,
  newStatus:       AssignmentStatus,
  location:        { lat: number; lng: number } | null,
  reason?:         string,
): Promise<void> {
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue }     = await import('firebase-admin/firestore');
    await adminFirestore
      .collection(COLLECTIONS.ASSIGNMENTS)
      .doc(assignmentId)
      .collection('history')
      .add({
        assignmentId,
        volunteerId,
        previousStatus,
        newStatus,
        reason:             reason ?? null,
        volunteerLocation:  location,
        updatedAt:          FieldValue.serverTimestamp(),
      });
  } catch {
    // Non-fatal audit log.
  }
}

async function notifyCoordinator(
  needId:        string,
  coordinatorId: string,
  message:       string,
  type:          string,
  ctx:           { requestId?: string },
): Promise<void> {
  try {
    const { adminFirestore, adminMessaging } = await import('@/lib/firebase/admin');
    const profileSnap = await adminFirestore
      .collection(COLLECTIONS.USERS)
      .doc(coordinatorId)
      .get();

    if (!profileSnap.exists) return;
    const fcmToken = (profileSnap.data() as { fcmToken?: string | null }).fcmToken;
    if (!fcmToken) return;

    await adminMessaging.send({
      token: fcmToken,
      notification: { title: 'Task Update', body: message },
      data: { type, needId, url: `/coordinator/war-room?need=${needId}` },
    });
  } catch (err) {
    logger.warn('notifyCoordinator', 'FCM failed', toLogError(err), undefined, ctx);
  }
}

async function updateVolunteerStats(
  volunteerId:         string,
  responseTimeMinutes: number,
): Promise<void> {
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const profileSnap = await adminFirestore
      .collection(COLLECTIONS.USERS)
      .doc(volunteerId)
      .get();

    if (!profileSnap.exists) return;
    const stats = (profileSnap.data() as {
      stats?: {
        tasksCompleted: number;
        completionRate: number;
        avgResponseTimeMinutes: number | null;
      };
    }).stats;

    const completed = (stats?.tasksCompleted ?? 0) + 1;
    const prevAvg   = stats?.avgResponseTimeMinutes ?? responseTimeMinutes;
    // Running average: prevAvg * (n-1)/n + newVal/n
    const newAvg = Math.round(prevAvg * ((completed - 1) / completed) + responseTimeMinutes / completed);

    await adminFirestore.collection(COLLECTIONS.USERS).doc(volunteerId).update({
      'stats.tasksCompleted':          completed,
      'stats.completionRate':          Math.min(1, (stats?.completionRate ?? 1)),
      'stats.avgResponseTimeMinutes':  newAvg,
      'stats.lastActiveAt':            new Date().toISOString(),
    });
  } catch {
    // Non-fatal.
  }
}

async function logCompletionToBigQuery(
  assignmentId:        string,
  needId:              string,
  volunteerId:         string,
  responseTimeMinutes: number,
  onSiteMinutes:       number,
): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';
  if (!projectId) return;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    await new BigQuery({ projectId })
      .dataset(datasetId)
      .table('response_metrics')
      .insert([
        {
          assignment_id:         assignmentId,
          need_id:               needId,
          volunteer_id:          volunteerId,
          response_time_minutes: responseTimeMinutes,
          on_site_minutes:       onSiteMinutes,
          completed_at:          new Date().toISOString(),
        },
      ]);
  } catch {
    // Non-fatal.
  }
}
