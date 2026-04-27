/**
 * POST /api/ai/translate — translate text between languages
 * Used by the volunteer app to show canonical need descriptions in the user's language.
 */

import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Language } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { createRateLimiter, getClientIp, rateLimitedResponse } from '@/lib/api/rateLimit';

const logger  = createServerLogger('ai-translate');
const limiter  = createRateLimiter({ limit: 60, windowMs: 60_000, prefix: 'ai-translate' });
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';

const bodySchema = z.object({
  text:           z.string().min(1).max(5000),
  targetLanguage: z.nativeEnum(Language),
  sourceLanguage: z.nativeEnum(Language).optional(),
});

interface TranslateResult {
  readonly translatedText: string;
  readonly sourceLang:     Language;
  readonly targetLang:     Language;
  readonly cached:         boolean;
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<ApiResponse<TranslateResult>>> {
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

  // If target is English and source is English — passthrough.
  if (body.targetLanguage === Language.ENGLISH && (body.sourceLanguage === Language.ENGLISH || !body.sourceLanguage)) {
    return NextResponse.json({
      success: true,
      data: { translatedText: body.text, sourceLang: Language.ENGLISH, targetLang: Language.ENGLISH, cached: true },
      error: null,
      requestId,
    });
  }

  try {
    const { translateFromEnglish, translateToEnglish } = await import('@/lib/ai/translate');

    let translatedText: string;
    let sourceLang: Language;

    if (body.targetLanguage === Language.ENGLISH) {
      const result = await translateToEnglish(body.text, body.sourceLanguage);
      translatedText = result.translatedText;
      sourceLang     = result.sourceLang;
    } else {
      translatedText = await translateFromEnglish(body.text, body.targetLanguage);
      sourceLang     = body.sourceLanguage ?? Language.ENGLISH;
    }

    logger.info('POST', 'translation complete', { targetLang: body.targetLanguage }, ctx);
    return NextResponse.json({
      success: true,
      data: { translatedText, sourceLang, targetLang: body.targetLanguage, cached: false },
      error: null,
      requestId,
    });
  } catch (err) {
    logger.error('POST', 'translation failed', toLogError(err), undefined, ctx);
    // Fallback: return original text so the UI never shows empty content.
    return NextResponse.json({
      success: true,
      data: { translatedText: body.text, sourceLang: body.sourceLanguage ?? Language.ENGLISH, targetLang: body.targetLanguage, cached: false },
      error: null,
      requestId,
    });
  }
}
