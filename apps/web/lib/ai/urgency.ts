/**
 * RahatNet Urgency Scoring Engine
 *
 * Produces an explainable urgency score [1–10] for every CanonicalNeed by
 * combining three independent signals with fixed weights:
 *
 *   Signal 1 — Keyword scoring (deterministic, 0 ms)
 *     Tiered regex match against a disaster-severity keyword map.
 *     Supports text in 8 Indian languages via the Cloud Translation API.
 *     Weight: 0.35
 *
 *   Signal 2 — Gemini Vision photo analysis (async, ~2 s)
 *     Sends attached photo to Gemini 1.5 Flash multimodal for visual severity.
 *     Falls back to neutral score 5 when no photo is available.
 *     Weight: 0.30
 *
 *   Signal 3 — Context signals (deterministic, 0 ms)
 *     Four sub-signals: affected count, vulnerability flag,
 *     report corroboration count, and time-since-first-report escalation.
 *     Weight: 0.35
 *
 * Final formula:
 *   score = (keyword × 0.35) + (photo × 0.30) + (context × 0.35)
 *   Clamped to [1, 10], rounded to nearest integer.
 *
 * Explainability:
 *   Every call returns a `factors` breakdown with the raw contribution of
 *   each signal.  This is stored in Firestore alongside the canonical need
 *   for model improvement and coordinator transparency.
 *
 * Score history:
 *   Each `calculateFinalUrgency` call appends a record to
 *   /urgencyScoreHistory/{needId} for off-line model training.
 *
 * A/B testing:
 *   A Firestore document /config/aiPipeline contains a flag
 *   `useVertexForUrgency: boolean`.  When true, `calculateFinalUrgency`
 *   delegates to `predictWithVertexModel` from vertex.ts instead of
 *   computing the three-signal formula locally.
 *
 * Server-only: never import this from 'use client' components.
 */

import { NeedSeverity, Language, toUrgencyScore } from '@rahatnet/types';
import type { UrgencyScore } from '@rahatnet/types';
import { callGeminiWithAudit } from './gemini';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All parameters needed to compute the urgency score for one need. */
export interface UrgencyParams {
  /** Raw text descriptions from the source reports (post-translation to English). */
  readonly descriptions:       readonly string[];
  /** BCP-47 language of the original descriptions (before translation). */
  readonly originalLanguage:   Language;
  /** base64 data URL of a single representative photo, or null. */
  readonly photoBase64:        string | null;
  /** Total number of people affected across all source reports. */
  readonly affectedCount:      number;
  /** True if any source report flagged a vulnerable person. */
  readonly hasVulnerable:      boolean;
  /** Number of distinct citizens who reported the same incident. */
  readonly reportCount:        number;
  /**
   * Unix ms timestamp of the earliest raw report in this cluster.
   * Used to apply time-escalation: stale needs become more urgent.
   */
  readonly firstReportedAt:    number;
  /** Firestore ID of the canonical need (for score history storage). */
  readonly needId:             string;
  /** Disaster event this need belongs to. */
  readonly disasterEventId:    string;
}

/** Detailed breakdown of the urgency scoring — stored for explainability. */
export interface UrgencyFactors {
  /** Raw keyword score [1–10] before weighting. */
  readonly keywordScore:            number;
  /** Keywords that matched (for coordinator display). */
  readonly matchedKeywords:         readonly string[];
  /** Raw photo score [1–10] before weighting; 5 when no photo. */
  readonly photoScore:              number;
  /** One-sentence reason from Gemini Vision. */
  readonly photoReason:             string;
  /** Raw context score [1–10] before weighting. */
  readonly contextScore:            number;
  /** Affected-count sub-signal contribution (step-function). */
  readonly affectedCountBonus:      number;
  /** Vulnerable-person sub-signal contribution (0 or +1.5). */
  readonly vulnerableBonus:         number;
  /** Report-count sub-signal contribution (log-based). */
  readonly reportCountBonus:        number;
  /** Time-since-first-report sub-signal contribution (step-function). */
  readonly staleEscalationBonus:    number;
  /** Whether the Vertex AI model was used instead of the local formula. */
  readonly usedVertexModel:         boolean;
  /** Gemini tokens consumed by the photo analysis (0 if no photo). */
  readonly photoTokensUsed:         number;
}

/** Full output of the urgency calculation. */
export interface UrgencyResult {
  /** Final urgency score [1–10]. */
  readonly score:                 UrgencyScore;
  /** Severity bucket derived from score. */
  readonly severity:              NeedSeverity;
  /**
   * Estimated minutes from NOW until a volunteer should arrive.
   * Derived from severity:
   *   CRITICAL  →  ≤ 15 min
   *   URGENT    →  ≤ 60 min
   *   NORMAL    →  ≤ 240 min
   *   LOW       →  ≤ 480 min
   */
  readonly estimatedResponseTimeMinutes: number;
  /** Full per-signal breakdown for explainability and model training. */
  readonly factors:               UrgencyFactors;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GeminiPhotoResponse {
  readonly score:  number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Keyword map — tiered by severity
// ---------------------------------------------------------------------------

/**
 * Each entry: { patterns, score } where `patterns` is a flat list of
 * substrings (checked with includes() after normalisation) or regex strings.
 *
 * Why substrings rather than word-boundary regex?
 *   Indian language romanisations often lack consistent word boundaries and
 *   may appear as part of compound words. Substring matching is more robust
 *   across transliteration variants.
 *
 * Native-script keywords are included as a fallback for when the translation
 * API is unavailable or returns an error — the normalised original text is
 * also tested.
 */
interface KeywordTier {
  readonly score:    number;
  /** Lowercase substrings to test with String.includes(). */
  readonly substrings: readonly string[];
  /** Optional regex for multi-word or complex patterns. */
  readonly patterns?:  readonly RegExp[];
}

const KEYWORD_TIERS: readonly KeywordTier[] = [
  // Score 10 — Immediate life threat
  {
    score: 10,
    substrings: [
      'drown', 'drowning', 'sinking', 'sank', 'underwater', 'submerged',
      'unconscious', 'unresponsive', 'cardiac', 'heart attack',
      'stroke', 'seizure', 'fire', 'burning', 'collapse', 'building fell',
    ],
    patterns: [
      /डूब/,          // Hindi: drowning
      /ഡൂബ്/,         // Malayalam
      /మునిగిపోతున్/,  // Telugu
      /மூழ்கி/,        // Tamil
    ],
  },
  // Score 9 — Critical, immediate response required
  {
    score: 9,
    substrings: [
      'critical', 'emergency', 'immediate', 'life-threatening', 'dying',
      'child alone', 'baby', 'newborn', 'infant', 'toddler', 'alone with child',
      'trapped', 'cannot escape', 'stuck inside',
    ],
    patterns: [
      /अकेला बच्चा/,  // Hindi: child alone
      /ഒറ്റ കുട്ടി/,  // Malayalam: child alone
    ],
  },
  // Score 8 — Serious, urgent response
  {
    score: 8,
    substrings: [
      'elderly', 'old person', 'senior citizen', 'disabled', 'wheelchair',
      'paralysed', 'paralyzed', 'bedridden', 'pregnant', 'labour', 'labor',
      'injured', 'bleeding', 'wound', 'fracture', 'broken bone', 'stuck',
    ],
    patterns: [
      /बुजुर्ग/,    // Hindi: elderly
      /वृद्ध/,      // Hindi: old person
      / വൃദ്ധ/,     // Malayalam: elderly
      /వృద్ధుడు/,   // Telugu
      /முதியோர்/,   // Tamil
    ],
  },
  // Score 7 — High need, multiple-hour urgency
  {
    score: 7,
    substrings: [
      'no food for 24', 'no food since yesterday', 'haven\'t eaten',
      'no water', 'no drinking water', 'dehydrated',
      'no medicine', 'out of medicine', 'medication finished',
      'diabetic', 'diabetes', 'blood pressure medicine', 'bp medicine',
      'insulin', 'heart patient', 'asthma', 'oxygen',
    ],
    patterns: [
      /24 घंटे से खाना नहीं/,  // Hindi: no food for 24 hours
      /ഭക്ഷണം ഇല്ല/,          // Malayalam: no food
    ],
  },
  // Score 6 — Significant, same-day response needed
  {
    score: 6,
    substrings: [
      'flooding', 'water rising', 'rising water', 'water level rising',
      'stranded', 'marooned', 'cut off', 'no power', 'no electricity',
      'roof leaking', 'about to collapse',
    ],
  },
  // Score 5 — Important, respond within a few hours
  {
    score: 5,
    substrings: [
      'shelter needed', 'no shelter', 'roof damage', 'road blocked',
      'help needed', 'need help', 'please help', 'sos', 'rescue needed',
    ],
  },
  // Score 3 — Low severity
  {
    score: 3,
    substrings: [
      'minor', 'small damage', 'inconvenience', 'slight', 'manageable',
    ],
  },
];

// ---------------------------------------------------------------------------
// Signal 1 — Keyword scoring
// ---------------------------------------------------------------------------

/** Normalise text for keyword matching: lowercase + strip punctuation. */
function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\sऀ-ॿഀ-ൿఀ-౿஀-௿ঀ-৿઀-૿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Attempt to translate text to English using the Cloud Translation API.
 * Returns the original text unchanged on any failure (translation is best-effort).
 */
async function translateToEnglish(text: string, fromLanguage: Language): Promise<string> {
  if (fromLanguage === Language.ENGLISH) return text;

  const apiKey = process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'] ?? process.env['GOOGLE_MAPS_SERVER_KEY'];
  if (!apiKey) return text; // No API key configured — skip translation.

  try {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        q:      text,
        source: fromLanguage,
        target: 'en',
        format: 'text',
      }),
    });

    if (!res.ok) return text;

    const data = (await res.json()) as {
      data?: { translations?: Array<{ translatedText?: string }> };
    };
    return data?.data?.translations?.[0]?.translatedText ?? text;
  } catch {
    return text;
  }
}

/**
 * Score text against the keyword urgency map.
 *
 * Tests both the (optionally translated) English text AND the native-script
 * regex patterns so the scorer works even if translation is unavailable.
 *
 * @param text             Description text (English preferred, native accepted).
 * @param originalLanguage BCP-47 language of the original text.
 * @returns score [1–10] and list of matched keyword tier labels.
 */
export async function scoreByKeywords(
  text:             string,
  originalLanguage: Language = Language.ENGLISH,
): Promise<{ score: number; matchedKeywords: readonly string[] }> {
  // Attempt to get an English version for substring matching.
  const englishText  = await translateToEnglish(text, originalLanguage);
  const normEnglish  = normaliseText(englishText);
  const normOriginal = normaliseText(text);

  let highestScore            = 3; // default baseline for any submitted report
  const matched: string[]     = [];

  for (const tier of KEYWORD_TIERS) {
    let tierHit = false;

    // Substring matches against English text.
    for (const sub of tier.substrings) {
      if (normEnglish.includes(sub) || normOriginal.includes(sub)) {
        matched.push(sub);
        tierHit = true;
        break;
      }
    }

    // Native-script regex matches (both texts).
    if (!tierHit && tier.patterns != null) {
      for (const pattern of tier.patterns) {
        if (pattern.test(normOriginal) || pattern.test(normEnglish)) {
          matched.push(pattern.source);
          tierHit = true;
          break;
        }
      }
    }

    if (tierHit) {
      highestScore = Math.max(highestScore, tier.score);
    }
  }

  return { score: highestScore, matchedKeywords: matched };
}

/**
 * Synchronous keyword scorer for unit tests and the deduplication module.
 * Does NOT translate — pass English text.
 */
export function scoreByKeywordsSync(text: string): { score: number; matchedKeywords: readonly string[] } {
  const norm     = normaliseText(text);
  let highScore  = 3;
  const matched: string[] = [];

  for (const tier of KEYWORD_TIERS) {
    let hit = false;

    for (const sub of tier.substrings) {
      if (norm.includes(sub)) {
        matched.push(sub);
        hit = true;
        break;
      }
    }

    if (!hit && tier.patterns != null) {
      for (const pattern of tier.patterns) {
        if (pattern.test(norm)) {
          matched.push(pattern.source);
          hit = true;
          break;
        }
      }
    }

    if (hit) highScore = Math.max(highScore, tier.score);
  }

  return { score: highScore, matchedKeywords: matched };
}

// ---------------------------------------------------------------------------
// Signal 2 — Gemini Vision photo analysis
// ---------------------------------------------------------------------------

/**
 * Score a single photo for disaster severity using Gemini Vision.
 *
 * @param photoBase64 A base64 data URL (data:image/jpeg;base64,...) or raw base64.
 * @returns { score, reason } — score [1–10], reason is one sentence for display.
 */
export async function scoreByPhoto(
  photoBase64: string,
): Promise<{ score: number; reason: string; tokensUsed: number }> {
  const prompt = `Analyze this disaster photo and score severity from 1-10:
10 = immediate life threat visible (person in water, fire, building collapse)
7-9 = serious danger (deep flooding, structural damage, trapped person)
4-6 = significant damage (flooded area, damaged property)
1-3 = minor impact (waterlogging, small damage)

Respond ONLY in JSON: { "score": number, "reason": "one sentence" }`;

  try {
    const result = await callGeminiWithAudit<GeminiPhotoResponse>(prompt, [photoBase64]);
    const score  = Math.max(1, Math.min(10, Math.round(result.value.score ?? 5)));
    return {
      score,
      reason:     result.value.reason ?? 'Severity assessed from photo.',
      tokensUsed: result.usage.totalTokens,
    };
  } catch {
    return { score: 5, reason: 'Photo analysis unavailable — using neutral score.', tokensUsed: 0 };
  }
}

// ---------------------------------------------------------------------------
// Signal 3 — Context signals (rule-based, deterministic)
// ---------------------------------------------------------------------------

export interface ContextSignals {
  readonly affectedCount:         number;
  readonly hasVulnerable:         boolean;
  readonly reportCount:           number;
  /** Unix ms timestamp of the first report in the cluster. */
  readonly firstReportedAt:       number;
}

export interface ContextScoreBreakdown {
  readonly total:                 number;
  readonly affectedCountBonus:    number;
  readonly vulnerableBonus:       number;
  readonly reportCountBonus:      number;
  readonly staleEscalationBonus:  number;
}

/**
 * Score the context signals and return a breakdown.
 *
 * Sub-signals and formulas (per spec):
 *
 *   affectedCount
 *     1 person     → +0
 *     2–5 persons  → +0.5
 *     6–10 persons → +1
 *     10+ persons  → +2
 *
 *   hasVulnerable (elderly/child/disabled)
 *     false → +0
 *     true  → +1.5
 *
 *   reportCount (corroboration signal)
 *     log10(count) × 1.5
 *     1 report → 0, 10 reports → 1.5, 100 reports → 3.0
 *
 *   timeSinceFirstReport (escalation)
 *     0–1 h  → +0    (still fresh)
 *     1–3 h  → +0.5  (delayed response warning)
 *     3+ h   → +1    (serious delay)
 *
 * Base score: 3 (any report that makes it to this system matters).
 * Final context score clamped to [1, 10].
 */
export function scoreByContext(signals: ContextSignals): ContextScoreBreakdown {
  // Affected count — step function.
  let affectedCountBonus: number;
  if (signals.affectedCount <= 1)       affectedCountBonus = 0;
  else if (signals.affectedCount <= 5)  affectedCountBonus = 0.5;
  else if (signals.affectedCount <= 10) affectedCountBonus = 1;
  else                                   affectedCountBonus = 2;

  // Vulnerability flag.
  const vulnerableBonus = signals.hasVulnerable ? 1.5 : 0;

  // Report count — log10 scale × 1.5.
  const reportCountBonus = Math.min(3, Math.log10(signals.reportCount + 1) * 1.5);

  // Time-since-first-report escalation — step function.
  const ageHours = (Date.now() - signals.firstReportedAt) / (1000 * 60 * 60);
  let staleEscalationBonus: number;
  if (ageHours < 1)      staleEscalationBonus = 0;
  else if (ageHours < 3) staleEscalationBonus = 0.5;
  else                    staleEscalationBonus = 1;

  const raw   = 3 + affectedCountBonus + vulnerableBonus + reportCountBonus + staleEscalationBonus;
  const total = Math.max(1, Math.min(10, raw));

  return {
    total,
    affectedCountBonus,
    vulnerableBonus,
    reportCountBonus,
    staleEscalationBonus,
  };
}

// ---------------------------------------------------------------------------
// Final composite score + severity mapping
// ---------------------------------------------------------------------------

/** Urgency score weights (must sum to 1.0). */
const WEIGHT_KEYWORD = 0.35;
const WEIGHT_PHOTO   = 0.30;
const WEIGHT_CONTEXT = 0.35;

/** Map score to severity bucket. */
export function scoreToSeverity(score: UrgencyScore): NeedSeverity {
  if (score >= 8) return NeedSeverity.CRITICAL;
  if (score >= 5) return NeedSeverity.URGENT;
  if (score >= 3) return NeedSeverity.NORMAL;
  return NeedSeverity.LOW;
}

/** Map severity to estimated response time in minutes. */
export function severityToResponseTime(severity: NeedSeverity): number {
  switch (severity) {
    case NeedSeverity.CRITICAL: return 15;
    case NeedSeverity.URGENT:   return 60;
    case NeedSeverity.NORMAL:   return 240;
    case NeedSeverity.LOW:      return 480;
  }
}

/**
 * Calculate the final urgency score for a canonical need.
 *
 * Checks the /config/aiPipeline Firestore document for the A/B flag
 * `useVertexForUrgency`.  When true, delegates to the Vertex AI model
 * (which falls back to local computation if the model is not deployed).
 *
 * On completion, persists the score record to /urgencyScoreHistory/{needId}
 * for offline model improvement.
 *
 * @returns UrgencyResult with score, severity, estimated response time, and factors.
 */
export async function calculateFinalUrgency(params: UrgencyParams): Promise<UrgencyResult> {
  // ── A/B flag check ────────────────────────────────────────────────────────
  let useVertex = false;
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const configSnap = await adminFirestore.doc('config/aiPipeline').get();
    useVertex = configSnap.exists && (configSnap.data() as { useVertexForUrgency?: boolean }).useVertexForUrgency === true;
  } catch {
    // Config read failure — use default (local scoring).
  }

  if (useVertex) {
    return calculateWithVertex(params);
  }

  return calculateLocal(params);
}

/** Local three-signal composite scoring. */
async function calculateLocal(params: UrgencyParams): Promise<UrgencyResult> {
  const allText = params.descriptions.join(' ');

  // Signal 1 — Keywords.
  const keywordResult = await scoreByKeywords(allText, params.originalLanguage);
  const keywordScore  = keywordResult.score;

  // Signal 2 — Photo.
  const photoResult   = params.photoBase64 != null
    ? await scoreByPhoto(params.photoBase64)
    : { score: 5, reason: 'No photo provided — using neutral score.', tokensUsed: 0 };

  // Signal 3 — Context.
  const contextBreakdown = scoreByContext({
    affectedCount:   params.affectedCount,
    hasVulnerable:   params.hasVulnerable,
    reportCount:     params.reportCount,
    firstReportedAt: params.firstReportedAt,
  });

  // Composite score.
  const raw    = keywordScore * WEIGHT_KEYWORD + photoResult.score * WEIGHT_PHOTO + contextBreakdown.total * WEIGHT_CONTEXT;
  const clamped = Math.round(Math.max(1, Math.min(10, raw)));
  const score   = toUrgencyScore(clamped);
  const severity = scoreToSeverity(score);

  const factors: UrgencyFactors = {
    keywordScore,
    matchedKeywords:      keywordResult.matchedKeywords,
    photoScore:           photoResult.score,
    photoReason:          photoResult.reason,
    contextScore:         contextBreakdown.total,
    affectedCountBonus:   contextBreakdown.affectedCountBonus,
    vulnerableBonus:      contextBreakdown.vulnerableBonus,
    reportCountBonus:     contextBreakdown.reportCountBonus,
    staleEscalationBonus: contextBreakdown.staleEscalationBonus,
    usedVertexModel:      false,
    photoTokensUsed:      photoResult.tokensUsed,
  };

  const result: UrgencyResult = {
    score,
    severity,
    estimatedResponseTimeMinutes: severityToResponseTime(severity),
    factors,
  };

  // Persist to score history (best-effort — don't block the response).
  void persistScoreHistory(params.needId, params.disasterEventId, result).catch(() => undefined);

  return result;
}

/** Vertex AI scoring path (falls back to local if model not deployed). */
async function calculateWithVertex(params: UrgencyParams): Promise<UrgencyResult> {
  try {
    const { predictWithVertexModel } = await import('./vertex');
    const vertexScore = await predictWithVertexModel({
      descriptions:    params.descriptions,
      affectedCount:   params.affectedCount,
      hasVulnerable:   params.hasVulnerable,
      reportCount:     params.reportCount,
      firstReportedAt: params.firstReportedAt,
      photoBase64:     params.photoBase64 ?? null,
    });

    const clamped  = Math.round(Math.max(1, Math.min(10, vertexScore)));
    const score    = toUrgencyScore(clamped);
    const severity = scoreToSeverity(score);

    // Still compute keyword/photo for explainability even in Vertex path.
    const keywordResult = await scoreByKeywords(params.descriptions.join(' '), params.originalLanguage);
    const photoResult   = params.photoBase64 != null
      ? await scoreByPhoto(params.photoBase64)
      : { score: 5, reason: 'No photo.', tokensUsed: 0 };
    const contextBreakdown = scoreByContext({
      affectedCount:   params.affectedCount,
      hasVulnerable:   params.hasVulnerable,
      reportCount:     params.reportCount,
      firstReportedAt: params.firstReportedAt,
    });

    const factors: UrgencyFactors = {
      keywordScore:         keywordResult.score,
      matchedKeywords:      keywordResult.matchedKeywords,
      photoScore:           photoResult.score,
      photoReason:          photoResult.reason,
      contextScore:         contextBreakdown.total,
      affectedCountBonus:   contextBreakdown.affectedCountBonus,
      vulnerableBonus:      contextBreakdown.vulnerableBonus,
      reportCountBonus:     contextBreakdown.reportCountBonus,
      staleEscalationBonus: contextBreakdown.staleEscalationBonus,
      usedVertexModel:      true,
      photoTokensUsed:      photoResult.tokensUsed,
    };

    const result: UrgencyResult = {
      score,
      severity,
      estimatedResponseTimeMinutes: severityToResponseTime(severity),
      factors,
    };

    void persistScoreHistory(params.needId, params.disasterEventId, result).catch(() => undefined);
    return result;
  } catch {
    // Vertex failure → fall back to local computation silently.
    return calculateLocal(params);
  }
}

/** Persist a score record to Firestore for model training data collection. */
async function persistScoreHistory(
  needId:         string,
  disasterEventId: string,
  result:         UrgencyResult,
): Promise<void> {
  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { FieldValue }     = await import('firebase-admin/firestore');

    await adminFirestore
      .collection('urgencyScoreHistory')
      .doc(needId)
      .set({
        needId,
        disasterEventId,
        score:        result.score,
        severity:     result.severity,
        factors:      result.factors,
        computedAt:   FieldValue.serverTimestamp(),
        modelVersion: result.factors.usedVertexModel ? 'vertex-v1' : 'local-v1',
      });
  } catch {
    // Non-fatal — score history is for training, not serving.
  }
}
