/**
 * RahatNet Volunteer Dispatch Algorithm
 *
 * Selects the best available volunteers for a given canonical need using a
 * four-signal weighted scoring model:
 *
 *   Signal 1 — Distance      (40%) driving minutes via Google Distance Matrix
 *   Signal 2 — Skill match   (35%) primary/secondary/no-match tiers
 *   Signal 3 — Language      (15%) reporter's language vs volunteer's languages
 *   Signal 4 — History       (10%) completion rate, rating, avg response time
 *
 * Infrastructure:
 *   - Distance Matrix responses are cached for 5 minutes per (volunteer, need)
 *     pair so repeated dispatches (e.g. after a decline) don't burn API quota.
 *   - A circuit breaker monitors Distance Matrix availability.  After 3
 *     consecutive failures it opens the circuit and falls back to Haversine
 *     straight-line distance for 2 minutes, then allows one probe request.
 *   - All intermediate scores are returned in the `VolunteerMatch` struct for
 *     coordinator transparency and BigQuery model training data.
 *
 * Server-only module — never import from 'use client' components.
 */

import {
  NeedType, NeedStatus, Language, VolunteerSkill,
  type CanonicalNeed, type VolunteerProfile,
  type RealtimeVolunteerLocation,
  COLLECTIONS,
} from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';

const logger = createServerLogger('dispatch');

// ---------------------------------------------------------------------------
// Score weights (must sum to 1.0)
// ---------------------------------------------------------------------------

const W_DISTANCE = 0.40;
const W_SKILL    = 0.35;
const W_LANGUAGE = 0.15;
const W_HISTORY  = 0.10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-signal score breakdown for one volunteer candidate. */
export interface ScoreBreakdown {
  readonly distanceScore:   number;  // 0–100
  readonly skillScore:      number;  // 0–100
  readonly languageScore:   number;  // 0–100
  readonly historyScore:    number;  // 0–100
  readonly compositeScore:  number;  // 0–100 (weighted sum)
  /** Driving time in minutes from Distance Matrix API (or Haversine fallback). */
  readonly estimatedDrivingMinutes: number;
  /** True when Haversine was used instead of Distance Matrix (circuit open). */
  readonly usedHaversineFallback: boolean;
}

/** A volunteer ranked by the dispatch algorithm. */
export interface VolunteerMatch {
  readonly uid:          string;
  readonly displayName:  string;
  readonly phoneNumber:  string | null;
  readonly skills:       readonly VolunteerSkill[];
  readonly languages:    readonly Language[];
  readonly location:     { lat: number; lng: number };
  readonly scores:       ScoreBreakdown;
}

// ---------------------------------------------------------------------------
// Distance Matrix response shape
// ---------------------------------------------------------------------------

interface DistanceElement {
  status:    string;
  duration?: { value: number; text: string };  // seconds
  distance?: { value: number; text: string };  // metres
}

interface DistanceMatrixApiResponse {
  status: string;
  rows:   Array<{ elements: DistanceElement[] }>;
}

// ---------------------------------------------------------------------------
// In-process TTL cache for Distance Matrix results
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly drivingMinutes: number;
  readonly expiresAt:      number;
}

/** Key = `${volunteerUid}:${needId}`, value = cached driving minutes. */
const distanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS  = 5 * 60 * 1_000; // 5 minutes

function getCached(volunteerUid: string, needId: string): number | null {
  const key   = `${volunteerUid}:${needId}`;
  const entry = distanceCache.get(key);
  if (entry === undefined) return null;
  if (Date.now() > entry.expiresAt) {
    distanceCache.delete(key);
    return null;
  }
  return entry.drivingMinutes;
}

function setCache(volunteerUid: string, needId: string, minutes: number): void {
  // Bound map size to 5000 entries to prevent unbounded memory growth.
  if (distanceCache.size >= 5_000) {
    const firstKey = distanceCache.keys().next().value;
    if (firstKey !== undefined) distanceCache.delete(firstKey);
  }
  distanceCache.set(`${volunteerUid}:${needId}`, {
    drivingMinutes: minutes,
    expiresAt:      Date.now() + CACHE_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker for Distance Matrix API
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  failures:         number;
  openedAt:         number | null;
  isOpen:           boolean;
  probePending:     boolean;
}

const circuitBreaker: CircuitBreakerState = {
  failures:     0,
  openedAt:     null,
  isOpen:       false,
  probePending: false,
};

const CB_FAILURE_THRESHOLD = 3;
const CB_RECOVERY_MS       = 2 * 60 * 1_000; // 2 minutes

function circuitIsOpen(): boolean {
  if (!circuitBreaker.isOpen) return false;

  // Auto-recover after the recovery window.
  if (
    circuitBreaker.openedAt !== null &&
    Date.now() - circuitBreaker.openedAt > CB_RECOVERY_MS
  ) {
    circuitBreaker.isOpen       = false;
    circuitBreaker.failures     = 0;
    circuitBreaker.openedAt     = null;
    circuitBreaker.probePending = false;
    logger.info('circuitBreaker', 'Distance Matrix circuit closed — retrying');
    return false;
  }

  return true;
}

function recordDistanceSuccess(): void {
  circuitBreaker.failures     = 0;
  circuitBreaker.isOpen       = false;
  circuitBreaker.openedAt     = null;
  circuitBreaker.probePending = false;
}

function recordDistanceFailure(ctx?: { requestId?: string }): void {
  circuitBreaker.failures += 1;
  if (circuitBreaker.failures >= CB_FAILURE_THRESHOLD && !circuitBreaker.isOpen) {
    circuitBreaker.isOpen   = true;
    circuitBreaker.openedAt = Date.now();
    logger.warn(
      'circuitBreaker',
      `Distance Matrix circuit OPEN after ${circuitBreaker.failures} failures — using Haversine fallback`,
      undefined, undefined, ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Haversine straight-line distance (metres) — circuit breaker fallback
// ---------------------------------------------------------------------------

function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate driving minutes from straight-line distance.
 * Uses a flood-zone speed assumption of 20 km/h (slow due to road damage,
 * debris, crowds) + a fixed 5-minute overhead for departure/navigation.
 */
function haversineToMinutes(metres: number): number {
  const hours  = metres / (20_000);   // 20 km/h
  const minutes = hours * 60 + 5;     // +5 min overhead
  return Math.round(minutes);
}

// ---------------------------------------------------------------------------
// Distance Matrix API (single volunteer → one destination)
// ---------------------------------------------------------------------------

/**
 * Get driving minutes from a volunteer's location to the need location.
 *
 * Falls back to Haversine when:
 *   - The circuit breaker is open (repeated API failures)
 *   - The result is cached (returns cached value, no API call)
 *   - The API key is not configured
 *   - Any fetch/parse error occurs
 */
async function getDrivingMinutes(
  volunteerUid: string,
  volunteerLat: number,
  volunteerLng: number,
  needLat:      number,
  needLng:      number,
  needId:       string,
  ctx?:         { requestId?: string },
): Promise<{ minutes: number; usedFallback: boolean }> {
  // Check cache first (before circuit breaker check).
  const cached = getCached(volunteerUid, needId);
  if (cached !== null) {
    return { minutes: cached, usedFallback: false };
  }

  // Circuit breaker open → use Haversine.
  if (circuitIsOpen()) {
    const metres  = haversineM(volunteerLat, volunteerLng, needLat, needLng);
    const minutes = haversineToMinutes(metres);
    return { minutes, usedFallback: true };
  }

  const apiKey = process.env['GOOGLE_MAPS_SERVER_KEY'] ?? process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'];
  if (!apiKey) {
    const metres  = haversineM(volunteerLat, volunteerLng, needLat, needLng);
    const minutes = haversineToMinutes(metres);
    return { minutes, usedFallback: true };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins',       `${volunteerLat},${volunteerLng}`);
  url.searchParams.set('destinations',  `${needLat},${needLng}`);
  url.searchParams.set('mode',          'driving');
  url.searchParams.set('key',           apiKey);
  // Avoid routing through flooded roads where possible.
  url.searchParams.set('avoid',         'ferries');

  try {
    const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Distance Matrix returned ${res.status}`);

    const data = (await res.json()) as DistanceMatrixApiResponse;

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK' || !element.duration) {
      throw new Error(`Distance Matrix element status: ${element?.status ?? 'missing'}`);
    }

    const minutes = Math.ceil(element.duration.value / 60);
    setCache(volunteerUid, needId, minutes);
    recordDistanceSuccess();
    return { minutes, usedFallback: false };
  } catch (err) {
    recordDistanceFailure(ctx);
    logger.warn('getDrivingMinutes', 'Distance Matrix failed — using Haversine', toLogError(err), undefined, ctx);
    const metres  = haversineM(volunteerLat, volunteerLng, needLat, needLng);
    const minutes = haversineToMinutes(metres);
    // Cache the fallback result too so repeated calls don't hammer a broken API.
    setCache(volunteerUid, needId, minutes);
    return { minutes, usedFallback: true };
  }
}

// ---------------------------------------------------------------------------
// Signal 1 — Distance score
// ---------------------------------------------------------------------------

/**
 * Convert driving minutes to a score [0–100].
 * Score = 100 - (drivingMinutes * 5), floored at 0.
 * A volunteer 0 min away scores 100; 20 min away scores 0.
 */
function scoreDistance(drivingMinutes: number): number {
  return Math.max(0, 100 - drivingMinutes * 5);
}

// ---------------------------------------------------------------------------
// Signal 2 — Skill match score
// ---------------------------------------------------------------------------

const PRIMARY_SKILLS: Record<NeedType, VolunteerSkill[]> = {
  [NeedType.RESCUE]:         [VolunteerSkill.BOAT_OPERATOR, VolunteerSkill.RESCUE_SWIMMER],
  [NeedType.MEDICINE]:       [VolunteerSkill.DOCTOR, VolunteerSkill.NURSE],
  [NeedType.FOOD]:           [VolunteerSkill.COOK],
  [NeedType.SHELTER]:        [VolunteerSkill.CARPENTER, VolunteerSkill.ELECTRICIAN],
  [NeedType.MENTAL_HEALTH]:  [VolunteerSkill.COUNSELLOR],
  [NeedType.INFRASTRUCTURE]: [VolunteerSkill.ELECTRICIAN, VolunteerSkill.CARPENTER],
};

const SECONDARY_SKILLS: Record<NeedType, VolunteerSkill[]> = {
  [NeedType.RESCUE]:         [VolunteerSkill.DRIVER],
  [NeedType.MEDICINE]:       [],
  [NeedType.FOOD]:           [VolunteerSkill.DRIVER],
  [NeedType.SHELTER]:        [],
  [NeedType.MENTAL_HEALTH]:  [],
  [NeedType.INFRASTRUCTURE]: [],
};

function scoreSkills(volunteerSkills: readonly VolunteerSkill[], needType: NeedType): number {
  const primary   = PRIMARY_SKILLS[needType]   ?? [];
  const secondary = SECONDARY_SKILLS[needType] ?? [];

  const hasPrimary   = volunteerSkills.some((s) => primary.includes(s));
  const hasSecondary = volunteerSkills.some((s) => secondary.includes(s));

  if (hasPrimary)   return 100;
  if (hasSecondary) return 60;
  return 20;
}

// ---------------------------------------------------------------------------
// Signal 3 — Language match score
// ---------------------------------------------------------------------------

function scoreLanguage(
  volunteerLanguages: readonly Language[],
  reporterLanguage:   Language,
): number {
  // Exact match — volunteer speaks the reporter's native language.
  if (volunteerLanguages.includes(reporterLanguage)) return 100;

  // Both speak English — they can communicate, just not natively.
  if (
    volunteerLanguages.includes(Language.ENGLISH) &&
    reporterLanguage === Language.ENGLISH
  ) return 100;

  if (volunteerLanguages.includes(Language.ENGLISH)) return 50;

  return 0;
}

// ---------------------------------------------------------------------------
// Signal 4 — History score
// ---------------------------------------------------------------------------

interface VolunteerStatsLike {
  readonly completionRate:          number | null | undefined;
  readonly averageRating:           number | null | undefined;
  readonly avgResponseTimeMinutes:  number | null | undefined;
  readonly tasksCompleted:          number;
}

/**
 * Normalise average response time to a 0–100 score.
 * Target: 8 minutes (score = 100).  20+ minutes → score 0.
 */
function responseTimeScore(avgMinutes: number | null | undefined): number {
  if (avgMinutes == null) return 50; // no history → neutral
  const target = 8;
  const worst  = 20;
  if (avgMinutes <= target) return 100;
  if (avgMinutes >= worst)  return 0;
  return Math.round(100 * (1 - (avgMinutes - target) / (worst - target)));
}

function scoreHistory(stats: VolunteerStatsLike | null | undefined): number {
  if (stats == null || stats.tasksCompleted === 0) return 50; // new volunteer → neutral

  const completionScore = (stats.completionRate ?? 0.5) * 100;
  const ratingScore     = ((stats.averageRating ?? 3) / 5) * 100;
  const responseScore   = responseTimeScore(stats.avgResponseTimeMinutes);

  return Math.round(completionScore * 0.5 + ratingScore * 0.3 + responseScore * 0.2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the top `count` available volunteers for a given canonical need.
 *
 * Steps:
 *   1. Read all available volunteers from RTDB /volunteerLocations.
 *   2. Fetch their Firestore profiles for skills, languages, history.
 *   3. For each candidate, compute the four scoring signals.
 *   4. Return the top `count` candidates sorted by composite score desc.
 *
 * @param need      The canonical need to match against.
 * @param count     Number of ranked candidates to return (default 3).
 * @param ctx       Optional request context for structured logging.
 */
export async function findBestVolunteers(
  need:  CanonicalNeed,
  count: number = 3,
  ctx?:  { requestId?: string; userId?: string },
): Promise<VolunteerMatch[]> {
  logger.info('findBestVolunteers', 'starting', {
    needId: need.id, needType: need.type, count,
  }, ctx);

  // 1. Read available volunteer locations from RTDB.
  const { adminFirestore } = await import('@/lib/firebase/admin');
  const { getDatabase }    = await import('firebase-admin/database');

  let rawLocations: Record<string, RealtimeVolunteerLocation> = {};
  try {
    const db   = getDatabase();
    const snap = await db.ref('volunteerLocations').get();
    rawLocations = (snap.val() as Record<string, RealtimeVolunteerLocation>) ?? {};
  } catch (err) {
    logger.warn('findBestVolunteers', 'RTDB read failed — no volunteer locations', toLogError(err), undefined, ctx);
    return [];
  }

  // Filter to only currently-available volunteers.
  const availableEntries = Object.entries(rawLocations).filter(
    ([, loc]) => loc.isAvailable,
  );

  if (availableEntries.length === 0) {
    logger.info('findBestVolunteers', 'no available volunteers', undefined, ctx);
    return [];
  }

  // 2. Fetch Firestore profiles for available volunteers.
  //    Batch into chunks of 30 (Firestore `in` operator limit).
  const uids       = availableEntries.map(([uid]) => uid);
  const profiles   = new Map<string, VolunteerProfile>();
  const CHUNK_SIZE = 30;

  for (let i = 0; i < uids.length; i += CHUNK_SIZE) {
    const chunk = uids.slice(i, i + CHUNK_SIZE);
    try {
      const snap = await adminFirestore
        .collection(COLLECTIONS.USERS)
        .where('__name__', 'in', chunk)
        .where('role', '==', 'VOLUNTEER')
        .get();
      for (const doc of snap.docs) {
        profiles.set(doc.id, doc.data() as VolunteerProfile);
      }
    } catch (err) {
      logger.warn('findBestVolunteers', 'profile batch fetch error', toLogError(err), { chunkStart: i }, ctx);
    }
  }

  // Detect the reporter's language from the raw reports (best-effort).
  // Fall back to ENGLISH when unavailable.
  let reporterLanguage: Language = Language.ENGLISH;
  try {
    if (need.sourceReportIds.length > 0) {
      const reportSnap = await adminFirestore
        .collection(COLLECTIONS.RAW_REPORTS)
        .doc(need.sourceReportIds[0] as string)
        .get();
      if (reportSnap.exists) {
        const lang = (reportSnap.data() as { originalLanguage?: string }).originalLanguage;
        if (lang && Object.values(Language).includes(lang as Language)) {
          reporterLanguage = lang as Language;
        }
      }
    }
  } catch {
    // Non-fatal — use ENGLISH fallback.
  }

  // 3. Score each candidate.
  const scored: Array<VolunteerMatch & { rank: number }> = [];

  for (const [uid, location] of availableEntries) {
    const profile = profiles.get(uid);
    if (!profile) continue;

    // Only dispatch to VERIFIED volunteers.
    if (profile.verificationStatus !== 'VERIFIED') continue;

    // Skip if already on an active assignment.
    if (profile.activeAssignmentId !== null && profile.activeAssignmentId !== undefined) continue;

    const { minutes, usedFallback } = await getDrivingMinutes(
      uid,
      location.lat,
      location.lng,
      need.location.lat,
      need.location.lng,
      need.id,
      ctx,
    );

    const dScore = scoreDistance(minutes);
    const sScore = scoreSkills(profile.skills ?? [], need.type);
    const lScore = scoreLanguage(profile.languages ?? [], reporterLanguage);
    const hScore = scoreHistory(profile.stats);

    const composite = Math.round(
      dScore * W_DISTANCE +
      sScore * W_SKILL    +
      lScore * W_LANGUAGE +
      hScore * W_HISTORY,
    );

    scored.push({
      uid,
      displayName:  profile.displayName,
      phoneNumber:  profile.phoneNumber,
      skills:       profile.skills     ?? [],
      languages:    profile.languages  ?? [],
      location:     { lat: location.lat, lng: location.lng },
      scores: {
        distanceScore:            dScore,
        skillScore:               sScore,
        languageScore:            lScore,
        historyScore:             hScore,
        compositeScore:           composite,
        estimatedDrivingMinutes:  minutes,
        usedHaversineFallback:    usedFallback,
      },
      rank: composite,
    });
  }

  // 4. Sort desc by composite score, return top `count`.
  scored.sort((a, b) => b.rank - a.rank);
  const topMatches = scored.slice(0, count).map(({ rank: _rank, ...match }) => match);

  logger.info('findBestVolunteers', 'completed', {
    candidates: scored.length,
    returned:   topMatches.length,
    topScore:   topMatches[0]?.scores.compositeScore ?? 0,
  }, ctx);

  return topMatches;
}

/**
 * Exported for unit tests and the war-room's "Best match" preview call.
 * These are the raw scoring functions, kept pure and testable.
 */
export {
  scoreDistance,
  scoreSkills,
  scoreLanguage,
  scoreHistory,
  haversineM,
  haversineToMinutes,
  responseTimeScore,
  PRIMARY_SKILLS,
  SECONDARY_SKILLS,
};
