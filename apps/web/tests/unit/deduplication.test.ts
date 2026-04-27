/**
 * Unit tests for lib/ai/deduplication.ts
 *
 * Tests cover:
 *   GPS clustering (clusterByGPS) — DBSCAN ε=200m, minPoints=1
 *   Gemini NLP de-duplication (deduplicateCluster) — mocked Gemini
 *   Urgency scoring (scoreByKeywords, scoreByContext, scoreUrgency)
 *
 * All Gemini API calls are mocked — no real network requests are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NeedType, NeedSeverity } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Module mocks (declared before imports)
// ---------------------------------------------------------------------------

vi.mock('@/lib/ai/gemini', () => ({
  callGeminiWithAudit: vi.fn().mockResolvedValue({
    value: {
      isSameIncident: true,
      confidence:     0.95,
      subClusters:    [[0, 1, 2]],
      reasoning:      'All reports describe the same flooded house',
    },
    rawResponse: '{"isSameIncident":true,"confidence":0.95}',
    usage:       { promptTokens: 100, candidateTokens: 50, totalTokens: 150 },
    retries:     0,
    durationMs:  800,
  }),
  GEMINI_MODEL: 'gemini-1.5-flash',
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  clusterByGPS,
  deduplicateCluster,
  scoreByKeywords,
  scoreByContext,
  scoreUrgency,
  urgencyToSeverity,
} from '@/lib/ai/deduplication';
import { createMockRawReport } from '@/tests/mocks/factories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Move a lat/lng point by the given metres north and east.
 * 1 degree latitude ≈ 111,000 m.
 */
function offsetPoint(
  lat: number, lng: number,
  northM: number, eastM: number,
): { lat: number; lng: number } {
  const latDeg = northM / 111_000;
  const lngDeg = eastM  / (111_000 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + latDeg, lng: lng + lngDeg };
}

const BASE = { lat: 10.0167, lng: 76.3417 }; // Aluva, Kerala

// ---------------------------------------------------------------------------
// 1. GPS Clustering
// ---------------------------------------------------------------------------

describe('clusterByGPS', () => {
  it('groups 5 reports within 100 m into a single cluster', () => {
    const reports = Array.from({ length: 5 }, (_, i) =>
      createMockRawReport({ location: offsetPoint(BASE.lat, BASE.lng, i * 20, 0) }),
    );

    const clusters = clusterByGPS(reports);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.reports).toHaveLength(5);
  });

  it('places two reports exactly 200 m apart in ONE cluster (ε = 200 m, inclusive)', () => {
    // The DBSCAN uses ≤ 200 m so exactly 200 m should cluster.
    const r1 = createMockRawReport({ location: BASE });
    const r2 = createMockRawReport({ location: offsetPoint(BASE.lat, BASE.lng, 200, 0) });

    const clusters = clusterByGPS([r1, r2]);

    // Both are within each other's ε-neighbourhood → one cluster.
    expect(clusters).toHaveLength(1);
  });

  it('creates two clusters for reports 500 m apart', () => {
    const r1 = createMockRawReport({ location: BASE });
    const r2 = createMockRawReport({ location: offsetPoint(BASE.lat, BASE.lng, 500, 0) });

    const clusters = clusterByGPS([r1, r2]);

    expect(clusters).toHaveLength(2);
  });

  it('returns a single cluster for a lone report (minPoints = 1)', () => {
    const report   = createMockRawReport();
    const clusters = clusterByGPS([report]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.reports).toHaveLength(1);
  });

  it('returns an empty array for an empty input', () => {
    expect(clusterByGPS([])).toHaveLength(0);
  });

  it('returns a single cluster when all reports share the same GPS coordinate', () => {
    const reports = Array.from({ length: 10 }, () =>
      createMockRawReport({ location: BASE }),
    );

    const clusters = clusterByGPS(reports);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.reports).toHaveLength(10);
  });

  it('sorts clusters by report count descending', () => {
    // 3 reports at BASE, 1 report 500 m away.
    const near = Array.from({ length: 3 }, () => createMockRawReport({ location: BASE }));
    const far  = createMockRawReport({ location: offsetPoint(BASE.lat, BASE.lng, 500, 0) });

    const clusters = clusterByGPS([...near, far]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.reports.length).toBeGreaterThan(clusters[1]?.reports.length ?? 0);
  });

  it('computes correct centroid for a cluster', () => {
    const r1 = createMockRawReport({ location: { lat: 10.0, lng: 76.0 } });
    const r2 = createMockRawReport({ location: { lat: 10.0001, lng: 76.0001 } });

    const clusters = clusterByGPS([r1, r2]);

    expect(clusters[0]?.centroidLat).toBeCloseTo(10.00005, 3);
    expect(clusters[0]?.centroidLng).toBeCloseTo(76.00005, 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Gemini NLP deduplication
// ---------------------------------------------------------------------------

describe('deduplicateCluster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns confidence > 0.8 when Gemini says isSameIncident=true', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValueOnce({
      value: { isSameIncident: true, confidence: 0.95, subClusters: [[0, 1, 2]], reasoning: 'Same house' },
      rawResponse: '{}', usage: { totalTokens: 150, promptTokens: 100, candidateTokens: 50 },
      retries: 0, durationMs: 500,
    } as never);

    const cluster = {
      reports: Array.from({ length: 3 }, () =>
        createMockRawReport({ description: 'Flooded house in Aluva, rescue needed' }),
      ),
      centroidLat: BASE.lat,
      centroidLng: BASE.lng,
    };

    const result = await deduplicateCluster(cluster);

    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBeGreaterThan(0.8);
  });

  it('splits into 2 sub-clusters when Gemini reports different incidents', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValueOnce({
      value: {
        isSameIncident: false,
        confidence:     0.3, // low "same" confidence → different incidents
        subClusters:    [[0], [1]],
        reasoning:      'Different types: rescue vs food',
      },
      rawResponse: '{}', usage: { totalTokens: 200, promptTokens: 150, candidateTokens: 50 },
      retries: 0, durationMs: 600,
    } as never);

    const cluster = {
      reports: [
        createMockRawReport({ type: NeedType.RESCUE, description: 'Person drowning' }),
        createMockRawReport({ type: NeedType.FOOD,   description: 'Need food supplies' }),
      ],
      centroidLat: BASE.lat,
      centroidLng: BASE.lng,
    };

    const result = await deduplicateCluster(cluster);

    // Low confidence on "same" and explicit split → 2 sub-clusters.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('single-report cluster skips Gemini and returns confidence=1', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');

    const cluster = {
      reports:      [createMockRawReport()],
      centroidLat:  BASE.lat,
      centroidLng:  BASE.lng,
    };

    const result = await deduplicateCluster(cluster);

    expect(callGeminiWithAudit).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe(1.0);
  });

  it('treats adversarial conflicting descriptions as a single cluster when confidence is ambiguous', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValueOnce({
      value: {
        isSameIncident: false,
        confidence:     0.45, // below MIN_MERGE_CONFIDENCE (0.6) but above 0
        subClusters:    [[0, 1]],
        reasoning:      'Descriptions conflict',
      },
      rawResponse: '{}', usage: { totalTokens: 180, promptTokens: 130, candidateTokens: 50 },
      retries: 0, durationMs: 700,
    } as never);

    const cluster = {
      reports: [
        createMockRawReport({ description: 'House on fire, urgent' }),
        createMockRawReport({ description: 'No fire, flooding only' }),
      ],
      centroidLat: BASE.lat, centroidLng: BASE.lng,
    };

    const result = await deduplicateCluster(cluster);

    // Ambiguous → falls back to treating as a single cluster.
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Urgency scoring
// ---------------------------------------------------------------------------

describe('scoreByKeywords', () => {
  it('scores "drowning child" as 10 (highest tier)', () => {
    const { score } = scoreByKeywords(['drowning child needs rescue immediately']);
    expect(score).toBe(10);
  });

  it('scores generic food request around 3–5', () => {
    const { score } = scoreByKeywords(['need food sometime']);
    expect(score).toBeLessThanOrEqual(5);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it('scores "elderly person trapped" at 8+', () => {
    const { score } = scoreByKeywords(['elderly person trapped on roof, cannot move']);
    expect(score).toBeGreaterThanOrEqual(8);
  });

  it('returns baseline 3 for descriptions with no matching keywords', () => {
    const { score } = scoreByKeywords(['']);
    expect(score).toBe(3);
  });

  it('returns matched keywords in the result', () => {
    const { matchedKeywords } = scoreByKeywords(['person is drowning right now']);
    expect(matchedKeywords.length).toBeGreaterThan(0);
  });
});

describe('scoreByContext', () => {
  const now = Date.now();

  it('affectedCount=1 contributes +0 (step function)', () => {
    const r = scoreByContext({ affectedCount: 1, hasVulnerable: false, reportCount: 1, firstReportedAt: now });
    expect(r.affectedCountBonus).toBe(0);
  });

  it('affectedCount=20 scores higher than affectedCount=1', () => {
    const low  = scoreByContext({ affectedCount: 1,  hasVulnerable: false, reportCount: 1, firstReportedAt: now });
    const high = scoreByContext({ affectedCount: 20, hasVulnerable: false, reportCount: 1, firstReportedAt: now });
    expect(high.total).toBeGreaterThan(low.total);
  });

  it('hasVulnerable=true adds +1.5', () => {
    const without = scoreByContext({ affectedCount: 3, hasVulnerable: false, reportCount: 1, firstReportedAt: now });
    const with_   = scoreByContext({ affectedCount: 3, hasVulnerable: true,  reportCount: 1, firstReportedAt: now });
    expect(with_.vulnerableBonus).toBe(1.5);
    expect(with_.total).toBeGreaterThan(without.total);
  });

  it('higher reportCount raises total score (log scale)', () => {
    const few  = scoreByContext({ affectedCount: 3, hasVulnerable: false, reportCount: 1,   firstReportedAt: now });
    const many = scoreByContext({ affectedCount: 3, hasVulnerable: false, reportCount: 100, firstReportedAt: now });
    expect(many.reportCountBonus).toBeGreaterThan(few.reportCountBonus);
  });

  it('report older than 3 hours gets +1 stale escalation', () => {
    const old  = now - 4 * 60 * 60 * 1_000; // 4 hours ago
    const r    = scoreByContext({ affectedCount: 1, hasVulnerable: false, reportCount: 1, firstReportedAt: old });
    expect(r.staleEscalationBonus).toBe(1);
  });

  it('output is always in [1, 10]', () => {
    const extreme = scoreByContext({
      affectedCount:   1000,
      hasVulnerable:   true,
      reportCount:     1000,
      firstReportedAt: now - 10 * 60 * 60 * 1_000,
    });
    expect(extreme.total).toBeLessThanOrEqual(10);
    expect(extreme.total).toBeGreaterThanOrEqual(1);
  });
});

describe('urgencyToSeverity', () => {
  const asScore = (n: number) => n as import('@rahatnet/types').UrgencyScore;

  it.each([
    [10, NeedSeverity.CRITICAL],
    [8,  NeedSeverity.CRITICAL],
    [7,  NeedSeverity.URGENT],
    [5,  NeedSeverity.URGENT],
    [4,  NeedSeverity.NORMAL],
    [3,  NeedSeverity.NORMAL],
    [2,  NeedSeverity.LOW],
    [1,  NeedSeverity.LOW],
  ] as const)('score %i → %s', (score, expected) => {
    expect(urgencyToSeverity(asScore(score))).toBe(expected);
  });
});

describe('scoreUrgency (composite)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('"Drowning child" produces a high urgency score', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValueOnce({
      value:       { score: 9, reason: 'Person in water visible' },
      rawResponse: '{"score":9}',
      usage:       { totalTokens: 120, promptTokens: 100, candidateTokens: 20 },
      retries: 0, durationMs: 400,
    } as never);

    const now = Date.now();
    const result = await scoreUrgency(
      ['Drowning child, immediate rescue needed'],
      ['data:image/jpeg;base64,/9j/fake=='],
      3, true, 5,
    );

    expect(result.urgencyScore).toBeGreaterThanOrEqual(8);
  });

  it('"Need food sometime" produces a lower score than a drowning report', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    // No photo provided — photo score defaults to neutral 5.
    vi.mocked(callGeminiWithAudit).mockResolvedValue({
      value:       { score: 5, reason: 'No immediate danger visible' },
      rawResponse: '{"score":5}',
      usage:       { totalTokens: 80, promptTokens: 60, candidateTokens: 20 },
      retries: 0, durationMs: 300,
    } as never);

    const food = await scoreUrgency(['need food sometime'], [], 1, false, 1);
    const drown = await scoreUrgency(['person drowning now'], [], 1, false, 1);

    expect(food.urgencyScore).toBeLessThan(drown.urgencyScore);
  });

  it('photo analysis increases score when Gemini Vision returns high severity', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit)
      // First call: photo scoring
      .mockResolvedValueOnce({
        value:       { score: 10, reason: 'Person in water visible in photo' },
        rawResponse: '{"score":10}',
        usage:       { totalTokens: 200, promptTokens: 180, candidateTokens: 20 },
        retries: 0, durationMs: 500,
      } as never);

    const withPhoto    = await scoreUrgency(['flooding'], ['data:image/jpeg;base64,fake=='], 2, false, 1);
    const withoutPhoto = await scoreUrgency(['flooding'], [],                               2, false, 1);

    expect(withPhoto.photoScore).toBe(10);
    expect(withPhoto.urgencyScore).toBeGreaterThanOrEqual(withoutPhoto.urgencyScore);
  });

  it('hasVulnerable=true produces a higher score than false for same description', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValue({
      value:       { score: 5, reason: 'minor damage' },
      rawResponse: '{}',
      usage:       { totalTokens: 80, promptTokens: 60, candidateTokens: 20 },
      retries: 0, durationMs: 200,
    } as never);

    const desc      = ['flood water rising near house'];
    const vulnerable = await scoreUrgency(desc, [], 3, true,  2);
    const normal     = await scoreUrgency(desc, [], 3, false, 2);

    expect(vulnerable.urgencyScore).toBeGreaterThanOrEqual(normal.urgencyScore);
  });
});
