/**
 * POST /api/coordinator/bootstrap
 *
 * Dev/demo helper: creates the active disaster event and promotes all
 * pending rawReports to canonical needs in the /needs collection.
 * Uses the real Gemini AI pipeline (classify + urgency scoring) when
 * GEMINI_API_KEY is available, otherwise falls back to heuristics.
 *
 * Only callable by COORDINATOR or ADMIN roles.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { COLLECTIONS, NeedStatus, NeedSeverity, NeedType } from '@rahatnet/types';
import type { ApiResponse } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';

const logger = createServerLogger('bootstrap');
const SESSION_COOKIE_NAME = (process.env['SESSION_COOKIE_NAME'] as string | undefined) ?? 'rahatnet_session';
const DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'active-disaster-001';

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<{ promoted: number }>>> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const ctx = { requestId };

  // Verify coordinator session
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!sessionCookie) {
    return NextResponse.json({ success: false, data: null, error: { code: 'AUTH_REQUIRED' as const, message: 'Not authenticated.', statusCode: 401 }, requestId }, { status: 401 });
  }

  try {
    const { verifySessionCookie, adminFirestore } = await import('@/lib/firebase/admin');
    const decoded = await verifySessionCookie(sessionCookie.value, ctx);
    const role = ((decoded as { role?: string }).role ?? '').toLowerCase();
    if (role !== 'coordinator' && role !== 'admin') {
      return NextResponse.json({ success: false, data: null, error: { code: 'FORBIDDEN' as const, message: 'Coordinator access required.', statusCode: 403 }, requestId }, { status: 403 });
    }

    // 1. Create disaster event if it doesn't exist
    const disasterRef = adminFirestore.collection(COLLECTIONS.DISASTER_EVENTS).doc(DISASTER_ID);
    const disasterSnap = await disasterRef.get();
    if (!disasterSnap.exists) {
      await disasterRef.set({
        id: DISASTER_ID,
        name: 'Active Flood Response',
        type: 'FLOOD',
        status: 'ACTIVE',
        severity: 'HIGH',
        affectedDistricts: ['Hyderabad'],
        state: 'Telangana',
        activatedAt: new Date(),
        activatedBy: decoded.uid,
        boundingBox: null,
        isDemoData: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      logger.info('POST', 'disaster event created', { id: DISASTER_ID }, ctx);
    }

    // 2. Promote pending rawReports to canonical needs
    const rawSnap = await adminFirestore
      .collection(COLLECTIONS.RAW_REPORTS)
      .where('status', '==', 'PENDING')
      .limit(50)
      .get();

    if (rawSnap.empty) {
      return NextResponse.json({ success: true, data: { promoted: 0 }, error: null, requestId });
    }

    let promoted = 0;
    const batch = adminFirestore.batch();

    const hasGemini = !!process.env['GEMINI_API_KEY'];

    for (const raw of rawSnap.docs) {
      const data = raw.data();
      const description = (data['description'] as string) ?? '';
      const rawNeedType = (data['needType'] as string) ?? 'RESCUE';
      const hasVulnerable = data['hasVulnerable'] as boolean ?? false;
      const affectedCount = data['affectedCount'] as number ?? 1;

      // ── AI Classification (Gemini) ──────────────────────────────────────
      let needType = rawNeedType;
      let urgencyScore = hasVulnerable ? 8 : 6; // fallback heuristic
      let severity = hasVulnerable ? NeedSeverity.CRITICAL : NeedSeverity.URGENT;

      if (hasGemini && description.length > 5) {
        try {
          const { scoreByKeywordsSync, scoreByContext, scoreToSeverity } = await import('@/lib/ai/urgency');

          // Keyword scoring (fast, no network)
          const kwResult = scoreByKeywordsSync(description);

          // Context scoring
          const ctxScore = scoreByContext({
            reportCount: 1,
            affectedCount,
            hasVulnerable,
            firstReportedAt: Date.now(),
          });

          // Combined score (keyword 40% + context 60%)
          urgencyScore = Math.round(kwResult.score * 0.4 + ctxScore.total * 0.6);
          urgencyScore = Math.max(1, Math.min(10, urgencyScore));
          severity = scoreToSeverity(urgencyScore as Parameters<typeof scoreToSeverity>[0]);

          logger.info('POST', 'urgency scored', { score: urgencyScore }, ctx);
        } catch (aiErr) {
          logger.warn('POST', 'scoring failed — using heuristic', undefined, { error: String(aiErr) }, ctx);
        }
      }

      // Call Gemini to classify need type from description
      if (hasGemini && description.length > 5) {
        try {
          const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
          const classifyPrompt = `Classify this disaster relief report into ONE of: RESCUE, FOOD, MEDICINE, SHELTER, MENTAL_HEALTH, INFRASTRUCTURE.
Report: "${description}"
Affected: ${affectedCount} people. Vulnerable: ${hasVulnerable}.
Respond with ONLY the category name, nothing else.`;
          const result = await callGeminiWithAudit<string>(classifyPrompt, []);
          const classified = String(result).trim().toUpperCase();
          if (['RESCUE','FOOD','MEDICINE','SHELTER','MENTAL_HEALTH','INFRASTRUCTURE'].includes(classified)) {
            needType = classified;
          }
          logger.info('POST', 'Gemini classified need', { type: needType }, ctx);
        } catch { /* keep original type */ }
      }

      // Create a canonical need from the raw report
      const needRef = adminFirestore.collection(COLLECTIONS.NEEDS).doc();
      batch.set(needRef, {
        id: needRef.id,
        disasterEventId: DISASTER_ID,
        title: `${needType.replace(/_/g, ' ')} need reported`,
        description,
        needType,
        status: NeedStatus.VERIFIED,
        severity,
        urgencyScore,
        location: data['location'] ?? { lat: 17.3850, lng: 78.4867, address: 'Unknown' },
        affectedCount,
        hasVulnerable,
        reporterIds: [data['reporterId']],
        rawReportIds: [raw.id],
        assignedVolunteerId: null,
        activeAssignmentId: null,
        photoUrls: data['photoUrls'] ?? [],
        language: data['language'] ?? 'en',
        aiProcessed: hasGemini,
        isDemoData: false,
        createdAt: data['createdAt'] ?? new Date(),
        updatedAt: new Date(),
      });

      // Mark raw report as processed
      batch.update(raw.ref, { status: 'PROCESSED', processedAt: new Date() });
      promoted++;
    }

    await batch.commit();
    logger.info('POST', 'reports promoted', { promoted }, ctx);

    return NextResponse.json({ success: true, data: { promoted }, error: null, requestId });
  } catch (err) {
    logger.error('POST', 'bootstrap failed', toLogError(err), undefined, ctx);
    return NextResponse.json({ success: false, data: null, error: { code: 'INTERNAL_ERROR' as const, message: 'Bootstrap failed.', statusCode: 500 }, requestId }, { status: 500 });
  }
}
