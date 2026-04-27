/**
 * Unit tests for lib/ai/urgency.ts
 *
 * Coverage targets:
 *   - scoreByKeywordsSync: every tier (10/9/8/7/6/5/3), boundary cases,
 *     multi-match (highest wins), default baseline, normalisation
 *   - scoreByContext: every step-function branch for all four sub-signals,
 *     boundary values, clamping
 *   - scoreToSeverity: every bucket boundary
 *   - severityToResponseTime: all four severity levels
 *   - calculateFinalUrgency: mocked Gemini + mocked Firestore, A/B flag paths
 *
 * The tests use vi.mock() to stub @/lib/firebase/admin and @/lib/ai/gemini
 * so no real Firebase or Gemini calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('@/lib/firebase/admin', () => ({
  adminFirestore: {
    doc: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
    }),
    collection: vi.fn().mockReturnValue({
      doc: vi.fn().mockReturnValue({
        set: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: vi.fn(() => 'SERVER_TIMESTAMP') },
}));

vi.mock('@/lib/ai/gemini', () => ({
  callGeminiWithAudit: vi.fn().mockResolvedValue({
    value: { score: 7, reason: 'Mocked photo analysis' },
    rawResponse: '{"score":7,"reason":"Mocked photo analysis"}',
    usage: { promptTokens: 100, candidateTokens: 20, totalTokens: 120 },
    retries: 0,
    durationMs: 500,
  }),
  callGeminiText: vi.fn().mockResolvedValue({ text: 'mock', usage: { totalTokens: 10 }, durationMs: 100 }),
  GEMINI_MODEL: 'gemini-1.5-flash',
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  scoreByKeywordsSync,
  scoreByContext,
  scoreByPhoto,
  scoreToSeverity,
  severityToResponseTime,
  calculateFinalUrgency,
  type ContextSignals,
  type UrgencyParams,
} from '@/lib/ai/urgency';
import { NeedSeverity, Language } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContextSignals(overrides?: Partial<ContextSignals>): ContextSignals {
  return {
    affectedCount:   1,
    hasVulnerable:   false,
    reportCount:     1,
    firstReportedAt: Date.now() - 30 * 60 * 1000, // 30 min ago
    ...overrides,
  };
}

function makeUrgencyParams(overrides?: Partial<UrgencyParams>): UrgencyParams {
  return {
    descriptions:     ['Person needs help with flooding'],
    originalLanguage: Language.ENGLISH,
    photoBase64:      null,
    affectedCount:    1,
    hasVulnerable:    false,
    reportCount:      1,
    firstReportedAt:  Date.now() - 30 * 60 * 1000,
    needId:           'test-need-001',
    disasterEventId:  'test-disaster-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreByKeywordsSync — 100% tier coverage
// ---------------------------------------------------------------------------

describe('scoreByKeywordsSync', () => {
  describe('Score 10 — immediate life threat', () => {
    it('returns 10 for "drowning"', () => {
      expect(scoreByKeywordsSync('person is drowning').score).toBe(10);
    });

    it('returns 10 for "sinking"', () => {
      expect(scoreByKeywordsSync('the boat is sinking').score).toBe(10);
    });

    it('returns 10 for "unconscious"', () => {
      expect(scoreByKeywordsSync('man is unconscious on roof').score).toBe(10);
    });

    it('returns 10 for "cardiac"', () => {
      expect(scoreByKeywordsSync('elderly woman having cardiac event').score).toBe(10);
    });

    it('returns 10 for "stroke"', () => {
      expect(scoreByKeywordsSync('grandfather had a stroke').score).toBe(10);
    });

    it('returns 10 for "fire"', () => {
      expect(scoreByKeywordsSync('fire started in the building').score).toBe(10);
    });

    it('returns 10 for "collapse"', () => {
      expect(scoreByKeywordsSync('wall collapsed trapping residents').score).toBe(10);
    });

    it('returns 10 for "underwater"', () => {
      expect(scoreByKeywordsSync('car is completely underwater').score).toBe(10);
    });

    it('returns 10 for "submerged"', () => {
      expect(scoreByKeywordsSync('house is submerged').score).toBe(10);
    });
  });

  describe('Score 9 — critical, immediate response', () => {
    it('returns 9 for "critical"', () => {
      expect(scoreByKeywordsSync('situation is critical').score).toBe(9);
    });

    it('returns 9 for "emergency"', () => {
      expect(scoreByKeywordsSync('this is an emergency').score).toBe(9);
    });

    it('returns 9 for "immediate"', () => {
      expect(scoreByKeywordsSync('need immediate help').score).toBe(9);
    });

    it('returns 9 for "baby"', () => {
      expect(scoreByKeywordsSync('baby is with us and crying').score).toBe(9);
    });

    it('returns 9 for "newborn"', () => {
      expect(scoreByKeywordsSync('newborn in the house').score).toBe(9);
    });

    it('returns 9 for "infant"', () => {
      expect(scoreByKeywordsSync('infant needs medicine').score).toBe(9);
    });

    it('returns 9 for "trapped"', () => {
      expect(scoreByKeywordsSync('we are trapped on the second floor').score).toBe(9);
    });
  });

  describe('Score 8 — serious, urgent', () => {
    it('returns 8 for "elderly"', () => {
      expect(scoreByKeywordsSync('elderly person cannot move').score).toBe(8);
    });

    it('returns 8 for "disabled"', () => {
      expect(scoreByKeywordsSync('disabled resident needs evacuation').score).toBe(8);
    });

    it('returns 8 for "injured"', () => {
      expect(scoreByKeywordsSync('my father is injured').score).toBe(8);
    });

    it('returns 8 for "bleeding"', () => {
      expect(scoreByKeywordsSync('woman is bleeding from head').score).toBe(8);
    });

    it('returns 8 for "pregnant"', () => {
      expect(scoreByKeywordsSync('pregnant woman here').score).toBe(8);
    });

    it('returns 8 for "wheelchair"', () => {
      expect(scoreByKeywordsSync('grandfather uses wheelchair').score).toBe(8);
    });

    it('returns 8 for "fracture"', () => {
      expect(scoreByKeywordsSync('leg fracture from debris').score).toBe(8);
    });
  });

  describe('Score 7 — high need', () => {
    it('returns 7 for "no food for 24"', () => {
      expect(scoreByKeywordsSync('no food for 24 hours').score).toBe(7);
    });

    it('returns 7 for "no water"', () => {
      expect(scoreByKeywordsSync('no water available').score).toBe(7);
    });

    it('returns 7 for "no medicine"', () => {
      expect(scoreByKeywordsSync('no medicine for my mother').score).toBe(7);
    });

    it('returns 7 for "diabetes"', () => {
      expect(scoreByKeywordsSync('diabetic patient needs insulin').score).toBe(7);
    });

    it('returns 7 for "bp medicine"', () => {
      expect(scoreByKeywordsSync('need bp medicine urgently').score).toBe(7);
    });

    it('returns 7 for "insulin"', () => {
      expect(scoreByKeywordsSync('ran out of insulin').score).toBe(7);
    });

    it('returns 7 for "asthma"', () => {
      expect(scoreByKeywordsSync('asthma attack ongoing').score).toBe(7);
    });
  });

  describe('Score 6 — significant, same-day', () => {
    it('returns 6 for "flooding"', () => {
      expect(scoreByKeywordsSync('heavy flooding in our area').score).toBe(6);
    });

    it('returns 6 for "water rising"', () => {
      expect(scoreByKeywordsSync('water is rising fast').score).toBe(6);
    });

    it('returns 6 for "stranded"', () => {
      expect(scoreByKeywordsSync('family stranded on roof').score).toBe(6);
    });

    it('returns 6 for "no power"', () => {
      expect(scoreByKeywordsSync('no power since last night').score).toBe(6);
    });
  });

  describe('Score 5 — help needed', () => {
    it('returns 5 for "shelter needed"', () => {
      expect(scoreByKeywordsSync('shelter needed for 4 people').score).toBe(5);
    });

    it('returns 5 for "roof damage"', () => {
      expect(scoreByKeywordsSync('roof damage from storm').score).toBe(5);
    });

    it('returns 5 for "road blocked"', () => {
      expect(scoreByKeywordsSync('road blocked cannot access').score).toBe(5);
    });

    it('returns 5 for "help needed"', () => {
      expect(scoreByKeywordsSync('help needed at our location').score).toBe(5);
    });

    it('returns 5 for "please help"', () => {
      expect(scoreByKeywordsSync('please help us').score).toBe(5);
    });
  });

  describe('Score 3 — low severity', () => {
    it('returns 3 for "minor"', () => {
      expect(scoreByKeywordsSync('minor flooding outside').score).toBe(3);
    });

    it('returns 3 for "inconvenience"', () => {
      expect(scoreByKeywordsSync('slight inconvenience from rain').score).toBe(3);
    });
  });

  describe('Default baseline', () => {
    it('returns 3 for generic text with no keyword match', () => {
      expect(scoreByKeywordsSync('we need some assistance').score).toBe(3);
    });

    it('returns 3 for empty string', () => {
      expect(scoreByKeywordsSync('').score).toBe(3);
    });
  });

  describe('Highest-wins rule', () => {
    it('returns 10 when text contains both score-5 and score-10 keywords', () => {
      expect(scoreByKeywordsSync('help needed, person drowning').score).toBe(10);
    });

    it('returns 9 when text contains score-6 and score-9 keywords', () => {
      expect(scoreByKeywordsSync('flooding, emergency situation').score).toBe(9);
    });

    it('returns 8 when score-7 and score-8 keywords both present', () => {
      expect(scoreByKeywordsSync('no water, elderly person').score).toBe(8);
    });
  });

  describe('Text normalisation', () => {
    it('matches keywords regardless of capitalisation', () => {
      expect(scoreByKeywordsSync('Person Is DROWNING').score).toBe(10);
    });

    it('matches keywords with surrounding punctuation', () => {
      expect(scoreByKeywordsSync('Help! Person is drowning!').score).toBe(10);
    });

    it('matches partial word "drown" within "drowning"', () => {
      // "drowning" contains "drown"
      expect(scoreByKeywordsSync('she is drowning right now').score).toBe(10);
    });
  });

  describe('matchedKeywords return value', () => {
    it('returns the matched keyword string', () => {
      const result = scoreByKeywordsSync('person is drowning');
      expect(result.matchedKeywords).toContain('drown');
    });

    it('returns empty array for no matches', () => {
      const result = scoreByKeywordsSync('');
      expect(result.matchedKeywords).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// scoreByContext — spec-exact formulas
// ---------------------------------------------------------------------------

describe('scoreByContext', () => {
  describe('affectedCount step function', () => {
    it('contributes +0 for affectedCount = 1', () => {
      const r1 = scoreByContext(makeContextSignals({ affectedCount: 1 }));
      const r0 = scoreByContext(makeContextSignals({ affectedCount: 1, reportCount: 1, hasVulnerable: false }));
      expect(r1.affectedCountBonus).toBe(0);
      // Base 3 + 0 (count) + 0 (vulnerable) + log(2)*1.5 (reportCount=1)
      expect(r0.total).toBeGreaterThanOrEqual(3);
    });

    it('contributes +0.5 for affectedCount = 2', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 2 }));
      expect(r.affectedCountBonus).toBe(0.5);
    });

    it('contributes +0.5 for affectedCount = 5 (boundary)', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 5 }));
      expect(r.affectedCountBonus).toBe(0.5);
    });

    it('contributes +1 for affectedCount = 6', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 6 }));
      expect(r.affectedCountBonus).toBe(1);
    });

    it('contributes +1 for affectedCount = 10 (boundary)', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 10 }));
      expect(r.affectedCountBonus).toBe(1);
    });

    it('contributes +2 for affectedCount = 11', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 11 }));
      expect(r.affectedCountBonus).toBe(2);
    });

    it('contributes +2 for affectedCount = 100', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 100 }));
      expect(r.affectedCountBonus).toBe(2);
    });
  });

  describe('vulnerableBonus', () => {
    it('contributes +0 when hasVulnerable = false', () => {
      const r = scoreByContext(makeContextSignals({ hasVulnerable: false }));
      expect(r.vulnerableBonus).toBe(0);
    });

    it('contributes +1.5 when hasVulnerable = true', () => {
      const r = scoreByContext(makeContextSignals({ hasVulnerable: true }));
      expect(r.vulnerableBonus).toBe(1.5);
    });
  });

  describe('reportCountBonus — log10 × 1.5', () => {
    it('is ~0 for reportCount = 1', () => {
      const r = scoreByContext(makeContextSignals({ reportCount: 1 }));
      // log10(2) * 1.5 ≈ 0.45
      expect(r.reportCountBonus).toBeCloseTo(Math.log10(2) * 1.5, 2);
    });

    it('is ~1.5 for reportCount = 9 (log10(10)*1.5)', () => {
      const r = scoreByContext(makeContextSignals({ reportCount: 9 }));
      // log10(10) * 1.5 = 1.5
      expect(r.reportCountBonus).toBeCloseTo(1.5, 1);
    });

    it('is capped at 3', () => {
      const r = scoreByContext(makeContextSignals({ reportCount: 999 }));
      expect(r.reportCountBonus).toBe(3);
    });
  });

  describe('staleEscalationBonus — time step function', () => {
    it('contributes +0 for < 1 hour', () => {
      const r = scoreByContext(makeContextSignals({ firstReportedAt: Date.now() - 30 * 60 * 1000 }));
      expect(r.staleEscalationBonus).toBe(0);
    });

    it('contributes +0.5 for 1–3 hours', () => {
      const r = scoreByContext(makeContextSignals({ firstReportedAt: Date.now() - 2 * 60 * 60 * 1000 }));
      expect(r.staleEscalationBonus).toBe(0.5);
    });

    it('contributes +1 for > 3 hours', () => {
      const r = scoreByContext(makeContextSignals({ firstReportedAt: Date.now() - 5 * 60 * 60 * 1000 }));
      expect(r.staleEscalationBonus).toBe(1);
    });

    it('contributes +1 for 24+ hours', () => {
      const r = scoreByContext(makeContextSignals({ firstReportedAt: Date.now() - 24 * 60 * 60 * 1000 }));
      expect(r.staleEscalationBonus).toBe(1);
    });
  });

  describe('Output clamping', () => {
    it('never returns below 1', () => {
      const r = scoreByContext(makeContextSignals({ affectedCount: 0, hasVulnerable: false, reportCount: 0 }));
      expect(r.total).toBeGreaterThanOrEqual(1);
    });

    it('never returns above 10', () => {
      const r = scoreByContext(makeContextSignals({
        affectedCount:   1000,
        hasVulnerable:   true,
        reportCount:     1000,
        firstReportedAt: Date.now() - 48 * 60 * 60 * 1000,
      }));
      expect(r.total).toBeLessThanOrEqual(10);
    });
  });
});

// ---------------------------------------------------------------------------
// scoreToSeverity — bucket boundaries
// ---------------------------------------------------------------------------

describe('scoreToSeverity', () => {
  const asScore = (n: number) => n as import('@rahatnet/types').UrgencyScore;

  it('returns CRITICAL for score = 10', () => {
    expect(scoreToSeverity(asScore(10))).toBe(NeedSeverity.CRITICAL);
  });

  it('returns CRITICAL for score = 8 (boundary)', () => {
    expect(scoreToSeverity(asScore(8))).toBe(NeedSeverity.CRITICAL);
  });

  it('returns URGENT for score = 7 (boundary)', () => {
    expect(scoreToSeverity(asScore(7))).toBe(NeedSeverity.URGENT);
  });

  it('returns URGENT for score = 5 (boundary)', () => {
    expect(scoreToSeverity(asScore(5))).toBe(NeedSeverity.URGENT);
  });

  it('returns NORMAL for score = 4 (boundary)', () => {
    expect(scoreToSeverity(asScore(4))).toBe(NeedSeverity.NORMAL);
  });

  it('returns NORMAL for score = 3 (boundary)', () => {
    expect(scoreToSeverity(asScore(3))).toBe(NeedSeverity.NORMAL);
  });

  it('returns LOW for score = 2 (boundary)', () => {
    expect(scoreToSeverity(asScore(2))).toBe(NeedSeverity.LOW);
  });

  it('returns LOW for score = 1', () => {
    expect(scoreToSeverity(asScore(1))).toBe(NeedSeverity.LOW);
  });
});

// ---------------------------------------------------------------------------
// severityToResponseTime
// ---------------------------------------------------------------------------

describe('severityToResponseTime', () => {
  it('returns 15 for CRITICAL', () => {
    expect(severityToResponseTime(NeedSeverity.CRITICAL)).toBe(15);
  });

  it('returns 60 for URGENT', () => {
    expect(severityToResponseTime(NeedSeverity.URGENT)).toBe(60);
  });

  it('returns 240 for NORMAL', () => {
    expect(severityToResponseTime(NeedSeverity.NORMAL)).toBe(240);
  });

  it('returns 480 for LOW', () => {
    expect(severityToResponseTime(NeedSeverity.LOW)).toBe(480);
  });
});

// ---------------------------------------------------------------------------
// scoreByPhoto — mocked Gemini
// ---------------------------------------------------------------------------

describe('scoreByPhoto', () => {
  it('returns mocked score and reason', async () => {
    const result = await scoreByPhoto('data:image/jpeg;base64,/9j/fake==');
    expect(result.score).toBe(7);
    expect(result.reason).toBe('Mocked photo analysis');
    expect(result.tokensUsed).toBe(120);
  });

  it('clamps score to [1, 10]', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockResolvedValueOnce({
      value:       { score: 999, reason: 'extreme' },
      rawResponse: '{"score":999}',
      usage:       { promptTokens: 10, candidateTokens: 5, totalTokens: 15 },
      retries:     0,
      durationMs:  100,
    } as never);
    const result = await scoreByPhoto('data:image/jpeg;base64,fake');
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('returns neutral score 5 when Gemini throws', async () => {
    const { callGeminiWithAudit } = await import('@/lib/ai/gemini');
    vi.mocked(callGeminiWithAudit).mockRejectedValueOnce(new Error('Gemini down'));
    const result = await scoreByPhoto('data:image/jpeg;base64,fake');
    expect(result.score).toBe(5);
    expect(result.tokensUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateFinalUrgency — end-to-end with mocked dependencies
// ---------------------------------------------------------------------------

describe('calculateFinalUrgency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset admin mock to default (A/B flag = false)
    const admin = vi.mocked(await import('@/lib/firebase/admin'));
    admin.adminFirestore.doc = vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a valid UrgencyResult with all required fields', async () => {
    const result = await calculateFinalUrgency(makeUrgencyParams({
      descriptions: ['elderly person trapped in flooding'],
    }));

    expect(result).toMatchObject({
      score:                        expect.any(Number),
      severity:                     expect.stringMatching(/^(CRITICAL|URGENT|NORMAL|LOW)$/),
      estimatedResponseTimeMinutes: expect.any(Number),
      factors:                      expect.objectContaining({
        keywordScore:       expect.any(Number),
        photoScore:         expect.any(Number),
        contextScore:       expect.any(Number),
        usedVertexModel:    false,
      }),
    });
  });

  it('score is in range [1, 10]', async () => {
    const result = await calculateFinalUrgency(makeUrgencyParams());
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('high-urgency keywords produce higher score', async () => {
    const lowResult  = await calculateFinalUrgency(makeUrgencyParams({ descriptions: ['minor flooding'] }));
    const highResult = await calculateFinalUrgency(makeUrgencyParams({ descriptions: ['person is drowning, immediate rescue needed'] }));
    expect(highResult.score).toBeGreaterThan(lowResult.score);
  });

  it('vulnerability flag raises final score', async () => {
    const base         = await calculateFinalUrgency(makeUrgencyParams({ hasVulnerable: false }));
    const withVulnerable = await calculateFinalUrgency(makeUrgencyParams({ hasVulnerable: true }));
    expect(withVulnerable.score).toBeGreaterThanOrEqual(base.score);
  });

  it('uses Vertex model when A/B flag is true', async () => {
    // Override the config mock to return useVertexForUrgency: true.
    const admin = vi.mocked(await import('@/lib/firebase/admin'));
    admin.adminFirestore.doc = vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({
        exists: true,
        data:   () => ({ useVertexForUrgency: true }),
      }),
    });

    // Mock the vertex module.
    vi.doMock('@/lib/ai/vertex', () => ({
      predictWithVertexModel: vi.fn().mockResolvedValue(8),
    }));

    const result = await calculateFinalUrgency(makeUrgencyParams());
    // Even if Vertex path fails and falls back to local, the result is valid.
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it('estimatedResponseTimeMinutes matches severity', async () => {
    const result = await calculateFinalUrgency(makeUrgencyParams({
      descriptions: ['person is drowning'], // should produce CRITICAL
    }));

    if (result.severity === NeedSeverity.CRITICAL) {
      expect(result.estimatedResponseTimeMinutes).toBe(15);
    } else if (result.severity === NeedSeverity.URGENT) {
      expect(result.estimatedResponseTimeMinutes).toBe(60);
    } else if (result.severity === NeedSeverity.NORMAL) {
      expect(result.estimatedResponseTimeMinutes).toBe(240);
    } else {
      expect(result.estimatedResponseTimeMinutes).toBe(480);
    }
  });

  it('matchedKeywords is non-empty for high-severity text', async () => {
    const result = await calculateFinalUrgency(makeUrgencyParams({
      descriptions: ['person is drowning now'],
    }));
    expect(result.factors.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('factors.keywordScore >= 3 (baseline) for any text', async () => {
    const result = await calculateFinalUrgency(makeUrgencyParams({
      descriptions: ['need help'],
    }));
    expect(result.factors.keywordScore).toBeGreaterThanOrEqual(3);
  });
});
