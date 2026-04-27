/**
 * GET  /api/needs/:id — fetch a single canonical need
 * PATCH /api/needs/:id — coordinator updates need status / fields
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { NeedStatus, COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, CanonicalNeed } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('needs-id');
const limiter  = createRateLimiter({ limit: 30, windowMs: 60_000, prefix: 'needs-id' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const patchSchema = z.object({
  status:              z.nativeEnum(NeedStatus).optional(),
  severity:            z.string().optional(),
  urgencyScore:        z.number().min(1).max(10).optional(),
  affectedCount:       z.number().int().min(1).optional(),
  hasVulnerable:       z.boolean().optional(),
  assignedVolunteerId: z.string().nullable().optional(),
  description:         z.string().max(2000).optional(),
  title:               z.string().max(300).optional(),
});

async function verifySession(request: NextRequest, ctx: { requestId?: string }) {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) return null;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    return await verifySessionCookie(sessionCookie.value, ctx);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<ApiResponse<CanonicalNeed>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifySession(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const snap = await adminFirestore.collection(COLLECTIONS.NEEDS).doc(params.id).get();

    if (!snap.exists) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'NOT_FOUND' as const, message: 'Need not found.', statusCode: 404 }, requestId },
        { status: 404 },
      );
    }

    const need = { id: snap.id, ...snap.data() } as CanonicalNeed;
    return NextResponse.json({ success: true, data: need, error: null, requestId });
  } catch (err) {
    logger.error('GET', 'fetch failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to fetch need.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — citizen can retract their own report if still PENDING
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifySession(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');

    // Fetch the raw report — only rawReports belong to a citizen directly.
    const docRef = adminFirestore.collection(COLLECTIONS.RAW_REPORTS).doc(params.id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'NOT_FOUND' as const, message: 'Report not found.', statusCode: 404 }, requestId },
        { status: 404 },
      );
    }

    const data = snap.data() as { reporterId?: string; status?: string };

    // Only the reporter can delete their own report.
    if (data.reporterId !== session.uid) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'You can only delete your own reports.', statusCode: 403 }, requestId },
        { status: 403 },
      );
    }

    // Only allow deletion of PENDING reports — once processing starts, a
    // coordinator may already be acting on it.
    const deletableStatuses = new Set(['PENDING', 'DUPLICATE']);
    if (!deletableStatuses.has(data.status ?? '')) {
      return NextResponse.json(
        { success: false, data: null, error: { code: 'CONFLICT' as const, message: 'This report is already being processed and cannot be deleted.', statusCode: 409 }, requestId },
        { status: 409 },
      );
    }

    await docRef.delete();
    logger.info('DELETE', 'report deleted', { id: params.id, uid: session.uid }, ctx);

    return NextResponse.json(
      { success: true, data: null, error: null, requestId },
      { status: 200 },
    );
  } catch (err) {
    logger.error('DELETE', 'unexpected error', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to delete report.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<ApiResponse<{ id: string }>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifySession(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  const role = session['role'] as string | undefined;
  if (role !== 'COORDINATOR' && role !== 'ADMIN') {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Coordinator role required.', statusCode: 403 }, requestId },
      { status: 403 },
    );
  }

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    await adminFirestore.collection(COLLECTIONS.NEEDS).doc(params.id).update({
      ...body,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info('PATCH', 'need updated', { id: params.id, fields: Object.keys(body) }, ctx);
    return NextResponse.json({ success: true, data: { id: params.id }, error: null, requestId });
  } catch (err) {
    logger.error('PATCH', 'update failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Update failed.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
