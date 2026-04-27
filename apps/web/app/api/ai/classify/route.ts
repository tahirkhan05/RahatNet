/**
 * POST /api/ai/classify — classify a single raw report into NeedType + urgency
 * Lightweight single-report classification (no de-duplication pipeline).
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { NeedType } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('ai-classify');
const limiter  = createRateLimiter({ limit: 30, windowMs: 60_000, prefix: 'ai-classify' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({
  description:     z.string().min(1).max(2000),
  originalLanguage: z.string().optional().default('en'),
  photoBase64:     z.string().optional(),
});

interface ClassifyResult {
  readonly needType:     NeedType;
  readonly urgencyScore: number;
  readonly confidence:   number;
  readonly reasoning:    string;
}

interface GeminiClassifyResponse {
  readonly needType?:     string;
  readonly urgencyScore?: number;
  readonly confidence?:   number;
  readonly reasoning?:    string;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<ClassifyResult>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ip = getClientIp(request);
  const ctx = { requestId, remoteIp: ip };

  const rl = limiter.check(ip);
  if (!rl.allowed) return rateLimitedResponse(rl, requestId);

  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) {
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

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { success: false, data: null, error: { code: 'VALIDATION_ERROR' as const, message: 'Invalid body.', statusCode: 400 }, requestId },
      { status: 400 },
    );
  }

  try {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');

    const prompt = `You are a disaster relief classifier for India.

Classify this report into the correct need type and estimate urgency.

Report: "${body.description}"

Valid needType values: RESCUE, FOOD, MEDICINE, SHELTER, MENTAL_HEALTH, INFRASTRUCTURE

Respond ONLY in JSON:
{
  "needType": "<one of the valid values>",
  "urgencyScore": <integer 1-10>,
  "confidence": <float 0-1>,
  "reasoning": "<one sentence>"
}`;

    const images = body.photoBase64 ? [body.photoBase64] : [];
    const result = await callGeminiWithAudit<GeminiClassifyResponse>(prompt, images);
    const g = result.value;

    const needType = Object.values(NeedType).includes(g.needType as NeedType)
      ? (g.needType as NeedType)
      : NeedType.RESCUE;

    const classified: ClassifyResult = {
      needType,
      urgencyScore: Math.max(1, Math.min(10, Math.round(g.urgencyScore ?? 5))),
      confidence:   Math.max(0, Math.min(1, g.confidence ?? 0.5)),
      reasoning:    g.reasoning ?? '',
    };

    logger.info('POST', 'classified', { needType, urgencyScore: classified.urgencyScore }, ctx);
    return NextResponse.json({ success: true, data: classified, error: null, requestId });
  } catch (err) {
    logger.error('POST', 'classification failed', toLogError(err), undefined, ctx);
    return NextResponse.json(
      { success: false, data: null, error: { code: 'GEMINI_ERROR' as const, message: 'Classification failed. Please try again.', statusCode: 503 }, requestId },
      { status: 503 },
    );
  }
}
