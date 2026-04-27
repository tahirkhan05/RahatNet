/**
 * POST /api/alerts/dismiss — log that a coordinator dismissed an alert banner
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger } from '@/lib/api/serverLogger';
import { getClientIp } from '@/lib/api/rateLimit';

const logger = createServerLogger('alerts-dismiss');
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({
  reason:       z.string().optional(),
  disasterName: z.string().optional(),
});

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<null>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ctx = { requestId, remoteIp: getClientIp(request) };

  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId },
      { status: 401 },
    );
  }

  let uid = 'unknown';
  try {
    const { verifySessionCookie } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    uid = decoded.uid;
  } catch { /* non-fatal — log and continue */ }

  const body = bodySchema.safeParse(await request.json().catch(() => ({})));
  const data = body.success ? body.data : {};

  logger.info('POST', 'alert dismissed', { uid, ...data }, ctx);

  return NextResponse.json({ success: true, data: null, error: null, requestId });
}
