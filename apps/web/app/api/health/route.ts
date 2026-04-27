/**
 * GET /api/health
 *
 * System health check endpoint used by:
 *   - CI/CD pipelines (smoke tests after deployment)
 *   - Load balancers / uptime monitors
 *   - The war-room header "Live" indicator
 *   - useOffline hook heartbeat (HEAD /api/health)
 *
 * Response shape:
 *   status   "ok" | "degraded" | "down"
 *   services per-service status (firestore, realtimeDb, gemini, maps)
 *   latency  timing for the slowest downstream calls
 *
 * Aggregation logic:
 *   ALL services ok  → status = "ok",       HTTP 200
 *   1 service error  → status = "degraded",  HTTP 207
 *   2+ services err  → status = "down",      HTTP 503
 *
 * Each service check has an independent 5-second timeout so one slow
 * service does not delay the entire response beyond ~5 s.
 */

import { NextResponse } from 'next/server';
import type { ApiResponse } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ServiceStatus {
  readonly status:    'ok' | 'error';
  readonly latencyMs?: number;
  readonly error?:    string;
}

interface HealthPayload {
  readonly status:    'ok' | 'degraded' | 'down';
  readonly timestamp: string;
  /** npm package version from the build environment. */
  readonly version:   string;
  /** Git commit SHA injected at build time by CI via NEXT_PUBLIC_COMMIT_SHA. */
  readonly commitSha: string;
  readonly services: {
    readonly firestore:   ServiceStatus;
    readonly realtimeDb:  ServiceStatus;
    readonly gemini:      ServiceStatus;
    readonly maps:        ServiceStatus;
  };
  readonly latency: {
    readonly firestoreMs:   number;
    readonly geminiMs:      number;
    readonly realtimeDbMs:  number;
  };
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 5_000;

const ERROR_FALLBACK: ServiceStatus = { status: 'error', error: 'timeout or check failed' };

async function runCheck<T>(fn: () => Promise<T>): Promise<T | ServiceStatus> {
  try {
    return await Promise.race<T | ServiceStatus>([
      fn(),
      new Promise<ServiceStatus>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    return {
      status:  'error',
      error:   err instanceof Error ? err.message : String(err),
      latencyMs: TIMEOUT_MS,
    };
  }
}

// ---------------------------------------------------------------------------
// Individual service checks
// ---------------------------------------------------------------------------

async function checkFirestore(): Promise<ServiceStatus> {
  const start = Date.now();
  return runCheck(async () => {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();
    // Lightweight ping — uses a sentinel document.  Not-found is fine.
    await db.collection('_health').doc('ping').get();
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  });
}

async function checkRealtimeDb(): Promise<ServiceStatus> {
  const start = Date.now();
  return runCheck(async () => {
    const { getDatabase } = await import('firebase-admin/database');
    const db = getDatabase();
    await db.ref('_health/ping').get();
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  });
}

async function checkGemini(): Promise<ServiceStatus> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    return { status: 'error', error: 'GEMINI_API_KEY not configured' };
  }
  const start = Date.now();
  return runCheck(async () => {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    // Minimal single-token ping — costs ~$0.000001.
    await model.generateContent('ping');
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  });
}

async function checkMaps(): Promise<ServiceStatus> {
  const apiKey =
    process.env['GOOGLE_MAPS_SERVER_KEY'] ??
    process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'];

  if (!apiKey) {
    return { status: 'error', error: 'Maps API key not configured' };
  }

  const start = Date.now();
  return runCheck(async () => {
    // Geocode a well-known address — always returns OK or ZERO_RESULTS.
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=Mumbai&key=${apiKey}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`Maps HTTP ${res.status}`);
    const data = (await res.json()) as { status: string };
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Maps status: ${data.status}`);
    }
    return { status: 'ok' as const, latencyMs: Date.now() - start };
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse<ApiResponse<HealthPayload>>> {
  const requestId = crypto.randomUUID();

  // All checks run concurrently — one slow service doesn't block others.
  const [firestoreResult, realtimeDbResult, geminiResult, mapsResult] =
    await Promise.allSettled([
      checkFirestore(),
      checkRealtimeDb(),
      checkGemini(),
      checkMaps(),
    ]);

  const services: HealthPayload['services'] = {
    firestore:   (firestoreResult.status  === 'fulfilled' ? firestoreResult.value  : ERROR_FALLBACK) as ServiceStatus,
    realtimeDb:  (realtimeDbResult.status === 'fulfilled' ? realtimeDbResult.value : ERROR_FALLBACK) as ServiceStatus,
    gemini:      (geminiResult.status     === 'fulfilled' ? geminiResult.value     : ERROR_FALLBACK) as ServiceStatus,
    maps:        (mapsResult.status       === 'fulfilled' ? mapsResult.value       : ERROR_FALLBACK) as ServiceStatus,
  };

  const errorCount  = Object.values(services).filter((s) => s.status === 'error').length;
  const overallStatus: HealthPayload['status'] =
    errorCount === 0 ? 'ok' :
    errorCount === 1 ? 'degraded' :
    'down';

  const payload: HealthPayload = {
    status:    overallStatus,
    timestamp: new Date().toISOString(),
    version:   process.env['npm_package_version'] ?? '1.0.0',
    commitSha: process.env['NEXT_PUBLIC_COMMIT_SHA'] ?? 'unknown',
    services,
    latency: {
      firestoreMs:   services.firestore.latencyMs   ?? 0,
      geminiMs:      services.gemini.latencyMs      ?? 0,
      realtimeDbMs:  services.realtimeDb.latencyMs  ?? 0,
    },
  };

  // In development, always return 200 so the offline banner doesn't appear
  // when Firebase services are not yet configured locally.
  const httpStatus =
    process.env.NODE_ENV === 'development' ? 200 :
    overallStatus === 'ok'       ? 200 :
    overallStatus === 'degraded' ? 207 :
    503;

  return NextResponse.json(
    { success: overallStatus !== 'down', data: payload, error: null, requestId },
    {
      status:  httpStatus,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Commit-Sha':  process.env['NEXT_PUBLIC_COMMIT_SHA'] ?? 'unknown',
      },
    },
  );
}

// HEAD is handled automatically by Next.js (same headers, no body).
// The useOffline hook uses { method: 'HEAD' } for minimal bandwidth.
