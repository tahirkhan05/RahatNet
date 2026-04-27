/**
 * PATCH /api/resources/:id — update deployed count or status
 * DELETE /api/resources/:id — remove a resource
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { COLLECTIONS } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger = createServerLogger('resources-id');
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000, prefix: 'resources-id' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const patchSchema = z.object({
  deployed: z.number().int().min(0).optional(),
  status: z.string().optional(),
  locationName: z.string().optional(),
});

async function verifyCoordinator(request: NextRequest, ctx: object) {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) return null;
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    const role = ((decoded as { role?: string }).role ?? '').toUpperCase();
    if (role !== 'COORDINATOR' && role !== 'ADMIN') return null;
    return decoded;
  } catch { return null; }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifyCoordinator(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Coordinator access required.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  let body: z.infer<typeof patchSchema>;
  try { body = patchSchema.parse(await request.json()); }
  catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    await adminFirestore.collection(COLLECTIONS.RESOURCES).doc(params.id).update({
      ...body,
      updatedAt: new Date(),
    });
    return NextResponse.json({ success: true, data: null, error: null, requestId });
  } catch (err) {
    logger.error('PATCH', 'update failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Update failed.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const session = await verifyCoordinator(request, ctx);
  if (!session) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Coordinator access required.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    await adminFirestore.collection(COLLECTIONS.RESOURCES).doc(params.id).delete();
    logger.info('DELETE', 'resource deleted', { id: params.id }, ctx);
    return NextResponse.json({ success: true, data: null, error: null, requestId });
  } catch (err) {
    logger.error('DELETE', 'delete failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Delete failed.', statusCode: 500 }, requestId },
      { status: 500 },
    );
  }
}
