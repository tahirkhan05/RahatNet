/**
 * POST /api/needs  — submit a citizen need report
 * GET  /api/needs  — paginated list of canonical needs (war room / volunteer)
 *
 * POST pipeline:
 *   1. Verify session cookie (must be authenticated).
 *   2. Validate body with Zod.
 *   3. Write a RawReport document to Firestore (/rawReports/{id}).
 *   4. Denormalise a minimal entry into the Realtime DB pending queue so
 *      the AI Cloud Function can pick it up without polling Firestore.
 *   5. Return the report ID so the client can track status.
 *
 * Rate limiting: 20 POST requests per minute per IP
 * (generous enough to drain the offline queue on reconnect).
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { NeedType, COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, PaginatedResponse, CanonicalNeed } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger = createServerLogger('needs');
const postLimiter = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'needs-post' });

const SESSION_COOKIE_NAME =
  (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const submitReportSchema = z.object({
  type: z.nativeEnum(NeedType),
  description: z.string().min(1).max(2000),
  originalDescription: z.string().min(1).max(2000),
  originalLanguage: z.string().min(2).max(5),
  /** base64 data URL or Firebase Storage URL — both accepted */
  voiceNoteUrl: z.string().nullable().optional(),
  photoUrls: z.array(z.string()).max(5).optional().default([]),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  locationName: z.string().min(1).max(300),
  affectedCount: z.number().int().min(1).max(1000),
  hasVulnerable: z.boolean(),
  disasterEventId: z.string().min(1),
  source: z.enum(['CITIZEN', 'SURVEY']).optional().default('CITIZEN'),
  surveyData: z
    .object({
      householdSize: z.number().int().min(1).max(100),
      landmark: z.string().max(300).optional(),
      surveyorName: z.string().max(200),
      surveyorOrg: z.string().max(200).optional(),
      hasDisability: z.boolean(),
      disabilityNotes: z.string().max(500).optional(),
      elderlyCount: z.number().int().min(0),
      childrenCount: z.number().int().min(0),
      hasPregnant: z.boolean(),
      hasChronicIllness: z.boolean(),
      hasNoFoodSecurity: z.boolean(),
      isFloodRisk: z.boolean(),
      hasCleanWater: z.boolean(),
      severityEstimate: z.string(),
      additionalNotes: z.string().max(1000).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<{ reportId: string }>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  // 1. Rate limit.
  const rl = postLimiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  // 2. Auth.
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

  let uid: string;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    uid = decoded.uid;
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

  // 3. Parse + validate.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR' as const,
          message: 'Invalid JSON body.',
          statusCode: 400,
        },
        requestId,
      },
      { status: 400 },
    );
  }

  const parsed = submitReportSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR' as const,
          message: 'Invalid report data.',
          details: parsed.error.flatten().fieldErrors,
          statusCode: 400,
        },
        requestId,
      },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const reportId = crypto.randomUUID();

  logger.info('POST', 'creating raw report', { uid, type: data.type, reportId }, ctx);

  // 4. Upload voice note base64 → Firebase Storage before Firestore write.
  let voiceNoteUrl: string | null = null;
  if (data.voiceNoteUrl != null && data.voiceNoteUrl.startsWith('data:')) {
    try {
      const { getStorage } = await import('firebase-admin/storage');
      const matches = data.voiceNoteUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1] ?? 'audio/webm';
        const base64Data = matches[2] ?? '';
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const filePath = `voice-notes/${reportId}.${ext}`;
        const bucket = getStorage().bucket();
        const file = bucket.file(filePath);
        await file.save(buffer, {
          contentType: mimeType,
          metadata: { cacheControl: 'private, max-age=86400' },
        });
        const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        voiceNoteUrl = signedUrl;
      }
    } catch (uploadErr) {
      logger.warn(
        'POST',
        'voice note upload failed — storing without audio',
        toLogError(uploadErr),
        undefined,
        ctx,
      );
    }
  } else if (data.voiceNoteUrl != null) {
    voiceNoteUrl = data.voiceNoteUrl; // already a URL (e.g. from offline queue sync)
  }

  // 5. Write to Firestore.
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    await adminFirestore
      .collection(COLLECTIONS.RAW_REPORTS)
      .doc(reportId)
      .set({
        reporterId: uid,
        type: data.type,
        description: data.description,
        originalDescription: data.originalDescription,
        originalLanguage: data.originalLanguage,
        voiceNoteUrl,
        photoUrls: data.photoUrls,
        location: data.location,
        locationName: data.locationName,
        affectedCount: data.affectedCount,
        hasVulnerable: data.hasVulnerable,
        source: data.source,
        ...(data.surveyData != null ? { surveyData: data.surveyData } : {}),
        status: 'PENDING',
        canonicalNeedId: null,
        disasterEventId: data.disasterEventId,
        createdAt: FieldValue.serverTimestamp(),
      });

    // 6. Best-effort RTDB entry to wake up the AI Cloud Function.
    try {
      const { getDatabase } = await import('firebase-admin/database');
      await getDatabase().ref(`pendingReports/${reportId}`).set({
        type: data.type,
        disasterEventId: data.disasterEventId,
        queuedAt: Date.now(),
      });
    } catch (rtdbErr) {
      logger.warn(
        'POST',
        'RTDB write failed — processor will pick up via Firestore',
        toLogError(rtdbErr),
        undefined,
        ctx,
      );
    }

    logger.info('POST', 'report created', { reportId }, ctx);

    return NextResponse.json(
      { success: true, data: { reportId }, error: null, requestId },
      { status: 201 },
    );
  } catch (err) {
    logger.error('POST', 'Firestore write failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: {
          code: 'FIRESTORE_ERROR' as const,
          message: 'Could not save your report. Please try again.',
          statusCode: 503,
        },
        requestId,
      },
      { status: 503 },
    );
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<PaginatedResponse<CanonicalNeed>>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const pageSize = Math.min(50, parseInt(searchParams.get('pageSize') ?? '20', 10));

  // Auth check.
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

  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    await verifySessionCookie(sessionCookie.value);
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

  // Full Firestore query for canonical needs will be implemented in Phase 5
  // (War Room dashboard) when coordinator filtering is needed.
  return NextResponse.json({
    success: true,
    data: { items: [], total: 0, page, pageSize, hasMore: false },
    error: null,
    requestId,
  });
}
