/**
 * GET  /api/resources — list resources for a disaster event
 * POST /api/resources — register a new resource
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ResourceType, ResourceStatus, ResourceCondition, COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse, PaginatedResponse, Resource } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('resources');
const limiter  = createRateLimiter({ limit: 20, windowMs: 60_000, prefix: 'resources' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const postSchema = z.object({
  type:            z.nativeEnum(ResourceType),
  description:     z.string().min(2).max(200),
  quantity:        z.number().int().min(1),
  locationName:    z.string().min(2).max(200),
  location:        z.object({ lat: z.number(), lng: z.number() }).optional(),
  disasterEventId: z.string().min(1),
  donorName:       z.string().max(100).optional(),
});

async function verifyCoordinator(request: NextRequest, ctx: { requestId?: string }) {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) return null;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    const role = decoded['role'] as string | undefined;
    if (role !== 'COORDINATOR' && role !== 'ADMIN') return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<PaginatedResponse<Resource>>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifyCoordinator(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const disasterEventId = searchParams.get('disasterId');
  const pageSize = Math.min(50, parseInt(searchParams.get('pageSize') ?? '50', 10));

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');

    let query = adminFirestore.collection(COLLECTIONS.RESOURCES).limit(pageSize);
    if (disasterEventId) query = query.where('disasterEventId', '==', disasterEventId);

    const snap = await query.get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Resource[];

    return NextResponse.json({
      success: true,
      data: { items, total: items.length, page: 1, pageSize, hasMore: false },
      error: null,
      requestId,
    });
  } catch (err) {
    logger.error('GET', 'resources fetch failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to fetch resources.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<{ resourceId: string }>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifyCoordinator(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Coordinator role required.', statusCode: 403 }, requestId },
      { status: 403 },
    );
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue } = await import('firebase-admin/firestore');

    const ref = adminFirestore.collection(COLLECTIONS.RESOURCES).doc();
    await ref.set({
      id:              ref.id,
      type:            body.type,
      description:     body.description,
      quantity:        body.quantity,
      deployed:        0,
      status:          ResourceStatus.AVAILABLE,
      condition:       ResourceCondition.GOOD,
      location:        body.location ?? { lat: 0, lng: 0 },
      locationName:    body.locationName,
      assignedTo:      null,
      disasterEventId: body.disasterEventId,
      donorName:       body.donorName ?? null,
      createdAt:       FieldValue.serverTimestamp(),
      updatedAt:       FieldValue.serverTimestamp(),
    });

    logger.info('POST', 'resource created', { resourceId: ref.id, type: body.type }, ctx);
    return NextResponse.json({ success: true, data: { resourceId: ref.id }, error: null, requestId }, { status: 201 });
  } catch (err) {
    logger.error('POST', 'resource creation failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Failed to create resource.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
