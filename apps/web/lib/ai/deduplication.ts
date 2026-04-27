/**
 * RahatNet AI De-duplication Engine
 *
 * Collapses hundreds of citizen reports about the same incident into a single
 * CanonicalNeed that the war-room coordinator sees and dispatches volunteers to.
 *
 * Pipeline (four phases):
 *
 *   Phase 1 — GPS Clustering (clusterByGPS)
 *     DBSCAN with ε = 200 m, minPoints = 1.
 *     Groups reports that are physically close enough to describe the same location.
 *     minPoints = 1 means every lone report forms its own cluster (no noise points).
 *
 *   Phase 2 — Gemini NLP De-duplication (deduplicateCluster)
 *     For each GPS cluster, Gemini reads all report descriptions and decides
 *     whether they describe the SAME incident or DIFFERENT incidents.
 *     If different → it splits the cluster into sub-clusters.
 *     Returns confidence 0–1.
 *
 *   Phase 3 — Canonical Need Generation (generateCanonicalNeed)
 *     Gemini synthesises all reports in a confirmed cluster into one clear
 *     canonical need card (title + description + extracted fields).
 *
 *   Phase 4 — Urgency Scoring (scoreUrgency)
 *     Three signals combined with fixed weights:
 *       keyword score (0.35) — lexical match against severity keywords
 *       photo score   (0.30) — Gemini Vision analyses attached photos
 *       context score (0.35) — affected count, vulnerability flag, report count
 *
 * All Gemini calls go through lib/ai/gemini.ts which enforces:
 *   - 30s timeout per call
 *   - 3 retries with exponential backoff on 429/503
 *   - 60 calls/min rate limit (in-process token bucket)
 *   - Token usage capture for BigQuery cost logging
 */

import {
  NeedType,
  NeedStatus,
  NeedSeverity,
  toUrgencyScore,
  type RawReport,
  type CanonicalNeed,
  type UrgencyScore,
  type GeoPoint,
} from '@rahatnet/types';
import { callGeminiWithAudit, GEMINI_MODEL } from './gemini';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A group of raw reports clustered by GPS proximity.
 * This is the input to the Gemini NLP de-duplication step.
 */
export interface RawReportCluster {
  /** All reports in this GPS cluster. */
  readonly reports: readonly RawReport[];
  /** Arithmetic mean latitude of all report locations. */
  readonly centroidLat: number;
  /** Arithmetic mean longitude of all report locations. */
  readonly centroidLng: number;
}

/**
 * The final output of the full de-duplication pipeline for one cluster.
 */
export interface DeduplicationResult {
  /** The synthesised need card ready to write to Firestore. */
  readonly canonicalNeed: CanonicalNeed;
  /** IDs of all raw reports that contributed to this need. */
  readonly sourceReportIds: readonly string[];
  /**
   * Gemini's confidence that all source reports describe the same incident.
   * Range: 0 (uncertain) to 1 (certain).
   */
  readonly confidence: number;
  /**
   * Raw Gemini response text from the de-duplication call.
   * Stored in Firestore for audit / model debugging.
   */
  readonly rawDedupeResponse: string;
  /**
   * Raw Gemini response text from the canonical-need generation call.
   */
  readonly rawCanonicalResponse: string;
  /**
   * Total Gemini token usage across all calls for this cluster.
   * Used for BigQuery cost tracking.
   */
  readonly totalTokensUsed: number;
}

// ---------------------------------------------------------------------------
// Internal: Gemini response shapes
// ---------------------------------------------------------------------------

interface GeminiDedupeResponse {
  readonly isSameIncident: boolean;
  readonly confidence: number;
  readonly subClusters: number[][];
  readonly reasoning: string;
}

interface GeminiCanonicalResponse {
  readonly title: string;
  readonly description: string;
  readonly needType: string;
  readonly locationName: string;
  readonly affectedCount: number;
  readonly hasVulnerable: boolean;
  readonly urgencyScore: number;
  readonly urgencyReasoning: string;
  readonly keywordScore: number;
  readonly contextScore: number;
}

interface GeminiPhotoScoreResponse {
  readonly score: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GPS_CLUSTER_RADIUS_M   = 200;
/** Minimum confidence to treat a cluster as a single incident. */
const MIN_MERGE_CONFIDENCE   = 0.6;
/** Maximum number of report descriptions sent to Gemini in one call. */
const MAX_REPORTS_PER_DEDUPE = 30;

// Urgency score weights (must sum to 1.0)
const WEIGHT_KEYWORD = 0.35;
const WEIGHT_PHOTO   = 0.30;
const WEIGHT_CONTEXT = 0.35;

// ---------------------------------------------------------------------------
// Phase 1 — GPS Clustering (DBSCAN, ε=200m, minPoints=1)
// ---------------------------------------------------------------------------

/**
 * Haversine great-circle distance between two WGS-84 coordinates.
 * Returns metres.
 */
function haversineDistanceM(a: GeoPoint, b: GeoPoint): number {
  const R  = 6_371_000; // Earth radius in metres
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;

  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);
  const hav    =
    sinΔφ * sinΔφ +
    Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ;

  return R * 2 * Math.asin(Math.sqrt(hav));
}

/**
 * DBSCAN clustering with ε = GPS_CLUSTER_RADIUS_M and minPoints = 1.
 *
 * With minPoints=1 every point is a core point, so there are no noise points —
 * every report ends up in exactly one cluster.  Clusters that have only one
 * report skip the NLP de-duplication step (trivially unique).
 *
 * Time complexity: O(n²) in the worst case, acceptable for batches ≤ 500 reports.
 * For larger batches, consider a spatial index (R-tree) — not needed at current scale.
 *
 * @returns Clusters sorted by report count descending (largest first).
 */
export function clusterByGPS(reports: readonly RawReport[]): RawReportCluster[] {
  const n       = reports.length;
  const visited = new Uint8Array(n); // 0 = unvisited, 1 = visited
  const cluster = new Int32Array(n).fill(-1); // cluster index per report
  let   clusterCount = 0;

  for (let i = 0; i < n; i++) {
    if (visited[i] === 1) continue;
    visited[i] = 1;

    // Find all reports within ε of report i.
    const neighbours: number[] = [];
    const ri = reports[i] as RawReport;
    for (let j = 0; j < n; j++) {
      const rj = reports[j] as RawReport;
      if (haversineDistanceM(ri.location, rj.location) <= GPS_CLUSTER_RADIUS_M) {
        neighbours.push(j);
      }
    }

    // With minPoints=1, i is always a core point.
    const cid = clusterCount++;
    cluster[i] = cid;

    // Expand cluster: add all reachable points (BFS).
    const queue = [...neighbours.filter((j) => j !== i)];
    while (queue.length > 0) {
      const k = queue.pop()!;
      if (visited[k] !== 1) {
        visited[k] = 1;
        const rk = reports[k] as RawReport;
        // Find neighbours of k.
        for (let j = 0; j < n; j++) {
          const rj = reports[j] as RawReport;
          if (haversineDistanceM(rk.location, rj.location) <= GPS_CLUSTER_RADIUS_M) {
            if (cluster[j] === -1) queue.push(j);
          }
        }
      }
      if (cluster[k] === -1) cluster[k] = cid;
    }
  }

  // Group reports by cluster ID.
  const clusterMap = new Map<number, RawReport[]>();
  for (let i = 0; i < n; i++) {
    const cid = cluster[i] as number;
    if (!clusterMap.has(cid)) clusterMap.set(cid, []);
    (clusterMap.get(cid) as RawReport[]).push(reports[i] as RawReport);
  }

  // Convert to RawReportCluster with centroid.
  const clusters: RawReportCluster[] = [];
  for (const clusterReports of clusterMap.values()) {
    const centroidLat =
      clusterReports.reduce((s, r) => s + r.location.lat, 0) / clusterReports.length;
    const centroidLng =
      clusterReports.reduce((s, r) => s + r.location.lng, 0) / clusterReports.length;
    clusters.push({ reports: clusterReports, centroidLat, centroidLng });
  }

  // Sort by descending report count — most corroborated incidents first.
  return clusters.sort((a, b) => b.reports.length - a.reports.length);
}

// ---------------------------------------------------------------------------
// Phase 2 — Gemini NLP De-duplication
// ---------------------------------------------------------------------------

/**
 * Ask Gemini whether all reports in a GPS cluster describe the SAME incident.
 *
 * If the cluster contains reports about different incidents (e.g. two separate
 * buildings flooded on the same street), Gemini returns sub-clusters which are
 * then processed independently.
 *
 * Limits the number of reports sent to MAX_REPORTS_PER_DEDUPE to stay within
 * Gemini's context window and keep the prompt readable.
 *
 * @returns Array of sub-clusters (each will become a separate CanonicalNeed).
 *          If the cluster is a single incident, returns `[cluster]`.
 */
export async function deduplicateCluster(
  cluster: RawReportCluster,
): Promise<Array<{ cluster: RawReportCluster; confidence: number; rawResponse: string }>> {
  // Single-report clusters are trivially unique — skip the NLP step.
  if (cluster.reports.length === 1) {
    return [{ cluster, confidence: 1.0, rawResponse: '(single report — no NLP needed)' }];
  }

  // Cap the number of reports in the prompt to avoid huge context windows.
  const sampleReports =
    cluster.reports.length > MAX_REPORTS_PER_DEDUPE
      ? [...cluster.reports].slice(0, MAX_REPORTS_PER_DEDUPE)
      : [...cluster.reports];

  const reportLines = sampleReports
    .map(
      (r, i) =>
        `[${i + 1}] "${r.description}" — ${r.type} — ${r.affectedCount} people affected` +
        (r.hasVulnerable ? ' (vulnerable person present)' : ''),
    )
    .join('\n');

  const prompt = `You are analyzing disaster reports during a flood emergency in India.

I have ${sampleReports.length} reports from within 200 meters of each other.
Determine if these are reports about the SAME incident or DIFFERENT incidents.

Reports:
${reportLines}

Rules for your decision:
- Reports describe the SAME incident if they refer to the same people/household in need.
- Reports describe DIFFERENT incidents if they refer to distinct people or locations even if nearby.
- If descriptions are vague or contradictory, lean toward SAME (err on the side of helping).
- Sub-clusters must partition ALL report indices [0..${sampleReports.length - 1}].

Respond ONLY in this JSON format (no other text, no markdown):
{
  "isSameIncident": boolean,
  "confidence": <number between 0 and 1>,
  "subClusters": <number[][]>,
  "reasoning": "<brief explanation in one sentence>"
}

If isSameIncident is true, subClusters must be [[0,1,2,...all indices]].
If isSameIncident is false, subClusters must group indices into 2+ non-overlapping, exhaustive partitions.`;

  const auditResult = await callGeminiWithAudit<GeminiDedupeResponse>(prompt);
  const response    = auditResult.value;

  // Validate the response structure.
  const confidence = Math.max(0, Math.min(1, response.confidence ?? 0.5));

  if (
    response.isSameIncident ||
    confidence >= MIN_MERGE_CONFIDENCE ||
    !Array.isArray(response.subClusters) ||
    response.subClusters.length < 2
  ) {
    // Treat as a single incident.
    return [
      {
        cluster,
        confidence,
        rawResponse: auditResult.rawResponse,
      },
    ];
  }

  // Split into sub-clusters as directed by Gemini.
  const result: Array<{ cluster: RawReportCluster; confidence: number; rawResponse: string }> = [];

  for (const indexGroup of response.subClusters) {
    if (!Array.isArray(indexGroup) || indexGroup.length === 0) continue;

    const subReports = indexGroup
      .filter((idx): idx is number => typeof idx === 'number' && idx >= 0 && idx < sampleReports.length)
      .map((idx) => sampleReports[idx] as RawReport);

    if (subReports.length === 0) continue;

    const subCentroidLat = subReports.reduce((s, r) => s + r.location.lat, 0) / subReports.length;
    const subCentroidLng = subReports.reduce((s, r) => s + r.location.lng, 0) / subReports.length;

    result.push({
      cluster:     { reports: subReports, centroidLat: subCentroidLat, centroidLng: subCentroidLng },
      confidence:  1 - confidence,  // sub-cluster confidence is inverse of "same" confidence
      rawResponse: auditResult.rawResponse,
    });
  }

  return result.length > 0
    ? result
    : [{ cluster, confidence: 0.5, rawResponse: auditResult.rawResponse }];
}

// ---------------------------------------------------------------------------
// Phase 3 — Canonical Need Generation
// ---------------------------------------------------------------------------

/**
 * Synthesise all reports in a cluster into a single canonical need card.
 *
 * Gemini reads all descriptions and extracts:
 *  - A clear, concise need title
 *  - A synthesised description (no duplication)
 *  - The dominant need type
 *  - The most precise location name
 *  - Affected count (conservative maximum across reports)
 *  - Vulnerability flag (OR across reports — any true → true)
 *  - Urgency score with breakdown
 *
 * The canonical need is NOT written to Firestore here — the route handler
 * does that so it can apply FieldValue.serverTimestamp() correctly.
 */
export async function generateCanonicalNeed(
  cluster:    RawReportCluster,
  needId:     string,
  confidence: number,
  disasterEventId: string,
): Promise<{ need: Omit<CanonicalNeed, 'createdAt' | 'updatedAt'>; rawResponse: string; tokensUsed: number }> {
  const reports       = cluster.reports;
  const reportSummary = reports
    .map(
      (r, i) =>
        `Report ${i + 1}:\n` +
        `  Type: ${r.type}\n` +
        `  Description: "${r.description}"\n` +
        `  Location: "${r.locationName}" (lat: ${r.location.lat.toFixed(5)}, lng: ${r.location.lng.toFixed(5)})\n` +
        `  People affected: ${r.affectedCount}\n` +
        `  Vulnerable person: ${r.hasVulnerable ? 'yes' : 'no'}`,
    )
    .join('\n\n');

  // Need type frequency analysis (deterministic — used as a fallback).
  const typeCounts = new Map<NeedType, number>();
  for (const r of reports) {
    typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
  }
  const dominantType = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? NeedType.RESCUE;

  // Aggregate context signals.
  const totalAffected  = reports.reduce((s, r) => s + r.affectedCount, 0);
  const maxAffected    = Math.max(...reports.map((r) => r.affectedCount));
  const hasVulnerable  = reports.some((r) => r.hasVulnerable);
  const reportCount    = reports.length;

  const prompt = `You are a disaster coordination AI synthesizing ${reportCount} field reports from a flood emergency in India into a single canonical need record.

--- REPORTS ---
${reportSummary}

--- TASK ---
Synthesize these reports into ONE canonical need record. Extract the most accurate, actionable information.

Rules:
- For affectedCount: use the MAXIMUM value reported (worst case is safer).
- For locationName: use the most specific location mentioned across reports.
- For needType: choose the most urgent need type if multiple appear.
- For the title: follow this exact format: "{NeedType} needed at {location} — {N} people affected"
  Example: "Rescue needed at Aluva Bridge — 7 people affected"
- For urgencyScore: integer 1-10 where 10 = immediate life threat, 1 = minor inconvenience.
  Consider: keywords like "drowning", "trapped", "critical" → high score.
  Elderly, child, disabled, pregnant persons → +1 to score.
  More reports of the same incident → higher score (more people know about it).
- For description: write 2-3 clear sentences. No repetition. Coordinator-facing.

Valid needType values: RESCUE, FOOD, MEDICINE, SHELTER, MENTAL_HEALTH, INFRASTRUCTURE

Respond ONLY in this JSON (no markdown, no extra text):
{
  "title": "<exact title string>",
  "description": "<2-3 sentence description>",
  "needType": "<one of the valid values>",
  "locationName": "<most precise location>",
  "affectedCount": <integer>,
  "hasVulnerable": <boolean>,
  "urgencyScore": <integer 1-10>,
  "urgencyReasoning": "<one sentence explaining the score>",
  "keywordScore": <float 1-10>,
  "contextScore": <float 1-10>
}`;

  const auditResult = await callGeminiWithAudit<GeminiCanonicalResponse>(prompt);
  const g           = auditResult.value;

  // Validate and clamp all numeric values.
  const rawUrgency     = Math.round(g.urgencyScore ?? 5);
  const clampedUrgency = Math.max(1, Math.min(10, rawUrgency));
  const urgencyScore   = toUrgencyScore(clampedUrgency);
  const severity       = urgencyToSeverity(urgencyScore);

  const validNeedType =
    Object.values(NeedType).includes(g.needType as NeedType)
      ? (g.needType as NeedType)
      : dominantType;

  // Use the centroid as the canonical location.
  const location: GeoPoint = {
    lat: cluster.centroidLat,
    lng: cluster.centroidLng,
  };

  const need: Omit<CanonicalNeed, 'createdAt' | 'updatedAt'> = {
    id:                 needId,
    title:              g.title || `${validNeedType} needed at ${g.locationName || 'Unknown location'} — ${g.affectedCount ?? maxAffected} people affected`,
    description:        g.description || reportSummary.slice(0, 500),
    type:               validNeedType,
    status:             NeedStatus.VERIFIED,
    severity,
    urgencyScore,
    location,
    locationName:       g.locationName || (reports[0]?.locationName ?? ''),
    affectedCount:      Math.max(g.affectedCount ?? 1, maxAffected),
    hasVulnerable:      g.hasVulnerable || hasVulnerable,
    sourceReportIds:    reports.map((r) => r.id),
    reportCount,
    assignedVolunteerId: null,
    assignedAt:         null,
    resolvedAt:         null,
    disasterEventId,
    aiProcessingMeta: {
      deduplicationConfidence: confidence,
      urgencyFactors: {
        keyword:     Math.max(1, Math.min(10, g.keywordScore ?? 5)),
        context:     Math.max(1, Math.min(10, g.contextScore ?? 5)),
        reportCount: Math.min(10, Math.log10(reportCount + 1) * 5 + 1),
        affectedCount: Math.min(10, (totalAffected / 10) + 1),
      },
      processingTimeMs: auditResult.durationMs,
      modelId:          GEMINI_MODEL,
      processedAt:      new Date().toISOString(),
    },
  };

  return {
    need,
    rawResponse:  auditResult.rawResponse,
    tokensUsed:   auditResult.usage.totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — Urgency Scoring
// ---------------------------------------------------------------------------

/**
 * Keyword-based urgency score (deterministic — no Gemini needed).
 *
 * Checks report text for severity keywords and returns a score 1–10.
 * This is the 'keyword' signal in the urgency score formula.
 */
export function scoreByKeywords(descriptions: readonly string[]): number {
  const combined = descriptions.join(' ').toLowerCase();

  const keywords: Array<{ pattern: RegExp; score: number }> = [
    { pattern: /\b(drown|drowning|sinking|underwater|submerged)\b/, score: 10 },
    { pattern: /\b(trapped|stuck|cannot escape|stranded|rescue)\b/,  score: 9  },
    { pattern: /\b(unconscious|cardiac|stroke|seizure|collapse|fire)\b/, score: 9 },
    { pattern: /\b(critical|emergency|immediate|urgent|life.threaten)\b/, score: 9 },
    { pattern: /\b(baby|newborn|infant|child alone|alone)\b/,        score: 9  },
    { pattern: /\b(elderly|disabled|pregnant|wheelchair|bedridden)\b/, score: 8 },
    { pattern: /\b(injured|bleeding|wound|broken|fracture)\b/,       score: 8  },
    { pattern: /\b(no food|no water|no medicine|no shelter)\b/,      score: 7  },
    { pattern: /\b(flood|water rising|rising water|overflow)\b/,     score: 6  },
    { pattern: /\b(damage|broken|destroyed)\b/,                       score: 5  },
    { pattern: /\b(help needed|need help|please help)\b/,            score: 5  },
  ];

  let score = 3; // baseline for any submitted report
  for (const { pattern, score: kScore } of keywords) {
    if (pattern.test(combined)) {
      score = Math.max(score, kScore);
    }
  }

  return score;
}

/**
 * Photo-based urgency score using Gemini Vision.
 *
 * Sends up to 3 photos to Gemini and gets a severity score 1–10.
 * Returns 5 (neutral) if no photos are provided.
 */
export async function scoreByPhotos(
  photoBase64s: readonly string[],
): Promise<{ score: number; reason: string; tokensUsed: number }> {
  if (photoBase64s.length === 0) {
    return { score: 5, reason: 'No photos provided — using neutral score', tokensUsed: 0 };
  }

  // Limit to 3 photos to keep the prompt manageable.
  const photos = photoBase64s.slice(0, 3);

  const prompt = `You are a disaster severity assessor. Analyze the provided disaster photo(s) from a flood emergency in India.

Score the severity from 1 to 10:
10 = Immediate life threat visible (person in water, collapse, fire)
8-9 = Serious danger (deep flooding, severe structural damage, trapped person)
5-7 = Significant damage (flooded area, damaged property, distressed people)
3-4 = Moderate impact (waterlogging, minor damage, no visible people at risk)
1-2 = Minor/unclear (no obvious danger)

Respond ONLY in this JSON (no markdown):
{
  "score": <integer 1-10>,
  "reason": "<one sentence describing what you see>"
}`;

  try {
    const auditResult = await callGeminiWithAudit<GeminiPhotoScoreResponse>(prompt, photos);
    const score       = Math.max(1, Math.min(10, Math.round(auditResult.value.score ?? 5)));
    return {
      score,
      reason:     auditResult.value.reason ?? '',
      tokensUsed: auditResult.usage.totalTokens,
    };
  } catch {
    // Photo scoring failure is non-fatal — use neutral score.
    return { score: 5, reason: 'Photo analysis failed — using neutral score', tokensUsed: 0 };
  }
}

/**
 * Context-based urgency score (deterministic).
 *
 * Aggregates:
 *  - Affected count signal    (log scale, capped at 10)
 *  - Vulnerability bonus      (+1.5 if elderly/child/disabled present)
 *  - Report count signal      (log scale — more reports = more corroboration)
 */
export function scoreByContext(params: {
  affectedCount:  number;
  hasVulnerable:  boolean;
  reportCount:    number;
}): number {
  const { affectedCount, hasVulnerable, reportCount } = params;

  // Affected count: 1 person → 3, 10 persons → 6, 100 persons → 9
  const affectedSignal = Math.min(10, 1 + Math.log10(affectedCount + 1) * 4.5);

  // Vulnerability bonus (+1.5 if any vulnerable person reported)
  const vulnerableBonus = hasVulnerable ? 1.5 : 0;

  // Report count signal: 1 report → 1, 10 reports → 5, 100 reports → 9
  const reportSignal = Math.min(9, Math.log10(reportCount + 1) * 4.5);

  const raw = affectedSignal + vulnerableBonus + reportSignal / 2;
  return Math.max(1, Math.min(10, raw));
}

/**
 * Composite urgency score combining all three signals.
 *
 * Formula:
 *   score = (keywordScore × 0.35) + (photoScore × 0.30) + (contextScore × 0.35)
 *
 * @returns UrgencyScore (branded number in [1, 10]).
 */
export async function scoreUrgency(
  descriptions:    readonly string[],
  photoBase64s:    readonly string[],
  affectedCount:   number,
  hasVulnerable:   boolean,
  reportCount:     number,
): Promise<{
  urgencyScore:   UrgencyScore;
  keywordScore:   number;
  photoScore:     number;
  contextScore:   number;
  photoReason:    string;
  totalTokens:    number;
}> {
  const keywordScore = scoreByKeywords(descriptions);
  const contextScore = scoreByContext({ affectedCount, hasVulnerable, reportCount });
  const photoResult  = await scoreByPhotos(photoBase64s);

  const raw = (
    keywordScore * WEIGHT_KEYWORD +
    photoResult.score * WEIGHT_PHOTO +
    contextScore * WEIGHT_CONTEXT
  );

  const clamped     = Math.round(Math.max(1, Math.min(10, raw)));
  const urgencyScore = toUrgencyScore(clamped);

  return {
    urgencyScore,
    keywordScore,
    photoScore:  photoResult.score,
    contextScore,
    photoReason: photoResult.reason,
    totalTokens: photoResult.tokensUsed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an urgency score [1–10] to a severity bucket.
 */
export function urgencyToSeverity(score: UrgencyScore): NeedSeverity {
  if (score >= 8) return NeedSeverity.CRITICAL;
  if (score >= 5) return NeedSeverity.URGENT;
  if (score >= 3) return NeedSeverity.NORMAL;
  return NeedSeverity.LOW;
}
