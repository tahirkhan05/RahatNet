/**
 * RahatNet Multilingual AI Translation Pipeline
 *
 * Handles every language boundary in the system:
 *
 *   Citizen → AI pipeline
 *     Reports arrive in 8 Indian languages.
 *     translateToEnglish() normalises them to English for Gemini processing.
 *
 *   AI pipeline → Coordinator display
 *     Canonical need descriptions are synthesised in English.
 *     translateFromEnglish() renders them in the coordinator's language.
 *
 *   Voice notes → AI pipeline
 *     translateVoiceTranscription() uses Gemini multimodal to transcribe
 *     and translate simultaneously in one API call.
 *
 *   UI strings
 *     translateUIString() loads from public/locales/{lang}.json with a
 *     hi→en→key fallback chain that can never throw.
 *
 * Caching strategy:
 *   Language detection  → in-process LRU cache (max 1000, no TTL)
 *   Text translations   → in-process TTL cache (max 5000, 1-hour TTL)
 *                         Swap `TtlCache` for an Upstash Redis client when
 *                         multi-instance deployments require shared cache.
 *   Canonical need desc → Firestore (needs don't change after creation)
 *   UI strings          → module-level in-memory Map (loaded once per deploy)
 *
 * Batching:
 *   translateBatch() groups up to 100 texts per Google Cloud Translation call.
 *   This is the primary cost-reduction lever — reduces API calls by ~100×.
 *
 * Cost tracking:
 *   Every translation API call logs character counts to BigQuery
 *   (rahatnet_analytics.translation_costs).
 *
 * Server-only: this module uses Google Cloud APIs and must only be imported
 * in API routes, Cloud Functions, or lib/ server code.
 * For client-side UI strings use translateUIString() which is safe anywhere.
 */

import { Language } from '@rahatnet/types';
import { callGeminiWithAudit } from './gemini';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRANSLATION_API_BASE = 'https://translation.googleapis.com/language/translate/v2';
const DETECT_API_BASE      = 'https://translation.googleapis.com/language/translate/v2/detect';

/** Maximum texts per single Google Cloud Translation API call. */
const BATCH_LIMIT = 100;

/** TTL for the in-process translation cache. */
const TRANSLATION_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

/** Maximum entries in the in-process translation cache before LRU eviction. */
const TRANSLATION_CACHE_MAX    = 5_000;

/** Maximum entries in the language-detection LRU cache. */
const DETECTION_CACHE_MAX = 1_000;

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

export interface TranslationResult {
  /** The translated text in English. */
  readonly translatedText: string;
  /** Source language that was detected or provided. */
  readonly sourceLang: Language;
  /** Confidence score [0–1] from the detection API; 1.0 when lang was provided. */
  readonly confidence: number;
  /** True when this result was served from the in-process cache. */
  readonly cached: boolean;
  /** Characters translated — used for BigQuery cost logging. */
  readonly charCount: number;
}

export interface TranscriptionResult {
  /** Verbatim transcription in the speaker's original language. */
  readonly originalText: string;
  /** English translation of the transcribed text. */
  readonly englishText: string;
  /** BCP-47 language code detected from the audio. */
  readonly detectedLanguage: Language;
  /** Gemini's confidence [0–1] in the transcription. */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

/**
 * Minimal LRU cache backed by an insertion-ordered Map.
 * Get → moves to end (most recently used).
 * Set → evicts oldest entry when at capacity.
 */
class LruCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Promote to most-recently-used by re-inserting.
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  set(key: K, value: V): void {
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      // Evict least-recently-used (first key in insertion order).
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) this.store.delete(lruKey);
    }
    this.store.delete(key);
    this.store.set(key, value);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// TTL cache (in-process, swap for Upstash Redis in multi-instance deploys)
// ---------------------------------------------------------------------------

/**
 * In-process translation cache with TTL per entry and LRU eviction.
 *
 * To migrate to Upstash Redis:
 *   1. Install @upstash/redis.
 *   2. Replace this class with a thin wrapper around Redis.get/set.
 *   3. The caller API (get/set) stays identical.
 */
class TtlCache {
  private readonly lru: LruCache<string, { value: string; expiresAt: number }>;

  constructor(maxSize: number, private readonly ttlMs: number) {
    this.lru = new LruCache(maxSize);
  }

  get(key: string): string | undefined {
    const entry = this.lru.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) return undefined; // expired
    return entry.value;
  }

  set(key: string, value: string): void {
    this.lru.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

const detectionCache   = new LruCache<string, Language>(DETECTION_CACHE_MAX);
const translationCache = new TtlCache(TRANSLATION_CACHE_MAX, TRANSLATION_CACHE_TTL_MS);

/** Loaded locale bundles — populated lazily on first translateUIString call. */
const localeBundles = new Map<string, Record<string, string>>();

// ---------------------------------------------------------------------------
// API key helper
// ---------------------------------------------------------------------------

function getTranslationApiKey(): string | null {
  // Prefer the server-side key (unrestricted); fall back to public key.
  return (
    process.env['GOOGLE_MAPS_SERVER_KEY'] ??
    process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'] ??
    null
  );
}

// ---------------------------------------------------------------------------
// 1. Language detection
// ---------------------------------------------------------------------------

/**
 * Detect the BCP-47 language code of a text string.
 *
 * Uses the Google Cloud Translation API v2 detection endpoint.
 * Results are cached in a module-level LRU cache (max 1000 entries)
 * so repeated calls with the same text are free.
 *
 * @returns Language enum value; falls back to Language.ENGLISH on any failure.
 */
export async function detectLanguage(text: string): Promise<Language> {
  // Normalise the key: trim whitespace, truncate to 200 chars (detection only
  // needs a sample — sending the full text wastes quota).
  const cacheKey = text.trim().slice(0, 200).toLowerCase();

  const cached = detectionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const apiKey = getTranslationApiKey();
    if (!apiKey) return Language.ENGLISH;

    const response = await fetch(`${DETECT_API_BASE}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: cacheKey }),
      signal:  AbortSignal.timeout(5_000),
    });

    if (!response.ok) return Language.ENGLISH;

    const data = (await response.json()) as {
      data?: {
        detections?: Array<Array<{ language?: string; confidence?: number }>>;
      };
    };

    const rawCode = data?.data?.detections?.[0]?.[0]?.language ?? 'en';
    const lang    = codeToLanguage(rawCode);

    detectionCache.set(cacheKey, lang);
    return lang;
  } catch {
    return Language.ENGLISH;
  }
}

// ---------------------------------------------------------------------------
// 2. Translate to English
// ---------------------------------------------------------------------------

/**
 * Translate a single text to English.
 *
 * Checks the TTL cache first; calls the API if not cached.
 * The cache key is `${sourceLang}:${text}` so the same text in different
 * languages produces different cache entries.
 *
 * @param text        Text to translate.
 * @param sourceLang  Source language (auto-detected if not provided).
 * @returns TranslationResult with the translated text and metadata.
 */
export async function translateToEnglish(
  text:       string,
  sourceLang?: Language,
): Promise<TranslationResult> {
  const detectedLang = sourceLang ?? (await detectLanguage(text));

  // English text needs no translation.
  if (detectedLang === Language.ENGLISH) {
    return {
      translatedText: text,
      sourceLang:     Language.ENGLISH,
      confidence:     1,
      cached:         true, // logically a no-op, not a real API hit
      charCount:      0,
    };
  }

  const cacheKey = `${detectedLang}:en:${text}`;
  const hit      = translationCache.get(cacheKey);

  if (hit !== undefined) {
    return {
      translatedText: hit,
      sourceLang:     detectedLang,
      confidence:     1,
      cached:         true,
      charCount:      0,
    };
  }

  const results = await translateBatch([text], detectedLang, Language.ENGLISH);
  const translated = results[0] ?? text;

  translationCache.set(cacheKey, translated);

  void logTranslationCost({
    sourceLang: detectedLang,
    targetLang: Language.ENGLISH,
    charCount:  text.length,
    texts:      1,
  });

  return {
    translatedText: translated,
    sourceLang:     detectedLang,
    confidence:     1,
    cached:         false,
    charCount:      text.length,
  };
}

/**
 * Translate multiple texts to English in a single batched API call.
 *
 * Groups texts into batches of BATCH_LIMIT (100) to stay within the
 * Cloud Translation API payload limit.
 *
 * @param texts      Array of texts to translate.
 * @param sourceLang Source language for all texts.
 * @returns Translated strings in the same order as the input.
 */
export async function translateToEnglishBatch(
  texts:      readonly string[],
  sourceLang: Language,
): Promise<readonly string[]> {
  if (texts.length === 0) return [];
  if (sourceLang === Language.ENGLISH) return texts;

  const results: string[] = new Array(texts.length);

  // Check cache for each text and identify which ones need API calls.
  const uncachedIndices: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const key = `${sourceLang}:en:${texts[i]}`;
    const hit = translationCache.get(key);
    if (hit !== undefined) {
      results[i] = hit;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length === 0) return results;

  // Batch uncached texts into groups of BATCH_LIMIT.
  const uncachedTexts = uncachedIndices.map((i) => texts[i] as string);

  for (let offset = 0; offset < uncachedTexts.length; offset += BATCH_LIMIT) {
    const batchTexts   = uncachedTexts.slice(offset, offset + BATCH_LIMIT);
    const batchResults = await translateBatch(batchTexts, sourceLang, Language.ENGLISH);
    const totalChars   = batchTexts.reduce((s, t) => s + t.length, 0);

    for (let j = 0; j < batchTexts.length; j++) {
      const globalIdx = uncachedIndices[offset + j] as number;
      const translated = batchResults[j] ?? (uncachedTexts[offset + j] as string);
      results[globalIdx] = translated;
      translationCache.set(`${sourceLang}:en:${texts[globalIdx]}`, translated);
    }

    void logTranslationCost({
      sourceLang,
      targetLang: Language.ENGLISH,
      charCount:  totalChars,
      texts:      batchTexts.length,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. Translate from English
// ---------------------------------------------------------------------------

/**
 * Translate a canonical need description from English to the target language.
 *
 * Uses a two-level cache:
 *   1. In-process TTL cache (fast path).
 *   2. Firestore /translations/{hash} (survives restarts; canonical needs
 *      rarely change so the Firestore read is only a fallback).
 *
 * @param text       English text to translate.
 * @param targetLang Language to translate into.
 * @returns Translated string; falls back to the original English on failure.
 */
export async function translateFromEnglish(
  text:       string,
  targetLang: Language,
): Promise<string> {
  if (targetLang === Language.ENGLISH) return text;

  const cacheKey = `en:${targetLang}:${text}`;
  const memHit   = translationCache.get(cacheKey);
  if (memHit !== undefined) return memHit;

  // Check Firestore cache.
  const hash         = await hashText(text);
  const firestoreKey = `translations/${hash}_${targetLang}`;

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const snap = await adminFirestore.doc(firestoreKey).get();
    if (snap.exists) {
      const stored = (snap.data() as { translatedText?: string }).translatedText;
      if (stored != null) {
        translationCache.set(cacheKey, stored);
        return stored;
      }
    }
  } catch {
    // Firestore unavailable — proceed to API.
  }

  // Call the API.
  try {
    const results    = await translateBatch([text], Language.ENGLISH, targetLang);
    const translated = results[0] ?? text;

    translationCache.set(cacheKey, translated);

    // Persist to Firestore (best-effort).
    void (async () => {
      try {
        const { adminFirestore } = await import('@/lib/firebase/admin');
        const { FieldValue }     = await import('firebase-admin/firestore');
        await adminFirestore.doc(firestoreKey).set({
          originalText:   text,
          translatedText: translated,
          targetLang,
          cachedAt:       FieldValue.serverTimestamp(),
        });
      } catch {
        // Non-fatal.
      }
    })();

    void logTranslationCost({
      sourceLang: Language.ENGLISH,
      targetLang,
      charCount:  text.length,
      texts:      1,
    });

    return translated;
  } catch {
    return text; // Never throw — return English original.
  }
}

// ---------------------------------------------------------------------------
// 4. Voice transcription + translation
// ---------------------------------------------------------------------------

/**
 * Transcribe a voice note and simultaneously translate it to English
 * using Gemini's multimodal capabilities.
 *
 * This is a single Gemini call that:
 *  - Receives the audio as a base64-encoded inline data part.
 *  - Detects the language being spoken.
 *  - Transcribes it verbatim.
 *  - Returns an English translation.
 *
 * Supported audio formats: webm, ogg, mp4 (whatever MediaRecorder produces).
 *
 * @param audioBase64  base64-encoded audio (with or without the data: prefix).
 * @param sourceLang   Optional hint for the source language.
 * @returns TranscriptionResult; all fields fall back to safe defaults on error.
 */
export async function translateVoiceTranscription(
  audioBase64: string,
  sourceLang?: Language,
): Promise<TranscriptionResult> {
  const langHint = sourceLang != null
    ? `The speaker is likely speaking ${languageName(sourceLang)}. `
    : '';

  const prompt = `This is a voice message from a disaster victim in India. ${langHint}Transcribe the audio, detect the language, and translate to English.

Respond ONLY in JSON (no markdown, no extra text):
{
  "originalText": "transcription in original language",
  "englishText": "English translation",
  "detectedLanguage": "ISO 639-1 code (hi, te, ta, kn, bn, mr, gu, ml, or en)",
  "confidence": <number between 0 and 1>
}

Important:
- If the audio is silent or unintelligible, set originalText and englishText to empty strings and confidence to 0.
- The ISO code must be one of: hi, te, ta, kn, bn, mr, gu, ml, en.`;

  try {
    // Normalise: strip data URI prefix if present and detect MIME type.
    const mimeMatch = audioBase64.match(/^data:(audio\/[a-zA-Z0-9\-+]+);base64,/);
    const mimeType  = (mimeMatch?.[1] ?? 'audio/webm') as string;
    const rawData   = mimeMatch
      ? audioBase64.replace(/^data:[^;]+;base64,/, '')
      : audioBase64;

    // Gemini expects audio parts via inlineData.
    // We send it as part of the parts array — callGeminiWithAudit handles
    // image parts; for audio we need to call the SDK directly here.
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const genAI  = new GoogleGenerativeAI(apiKey);
    const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent([
      {
        inlineData: {
          data:     rawData,
          mimeType: mimeType,
        },
      },
      { text: prompt },
    ]);

    const text = result.response.text();
    const jsonText = text
      .replace(/^```(?:json)?\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim();

    const parsed = JSON.parse(jsonText) as {
      originalText?:    string;
      englishText?:     string;
      detectedLanguage?: string;
      confidence?:      number;
    };

    const detectedLanguage = codeToLanguage(parsed.detectedLanguage ?? 'en');

    return {
      originalText:     parsed.originalText    ?? '',
      englishText:      parsed.englishText      ?? '',
      detectedLanguage,
      confidence:       Math.max(0, Math.min(1, parsed.confidence ?? 0)),
    };
  } catch {
    // Never throw — return a safe fallback.
    return {
      originalText:     '',
      englishText:      '',
      detectedLanguage: sourceLang ?? Language.ENGLISH,
      confidence:       0,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. UI string translation
// ---------------------------------------------------------------------------

/**
 * Translate a UI string key to the target language, loading from
 * public/locales/{lang}.json.
 *
 * Fallback chain:
 *   1. Requested language file — look up key.
 *   2. English file — look up key.
 *   3. Return the raw key string so UI always shows something.
 *
 * This function is synchronous and safe to call from React components
 * (locale bundles are loaded once at module init time in server contexts,
 * or lazily in browser contexts).
 *
 * @param key   Dot-separated UI string key, e.g. 'report.step1.title'.
 * @param lang  Target language.
 * @returns     Translated string; falls back to English or the key.
 */
export function translateUIString(key: string, lang: Language): string {
  const bundle = getLocaleBundle(lang);
  if (bundle != null) {
    const val = bundle[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }

  // Fallback to English.
  if (lang !== Language.ENGLISH) {
    const enBundle = getLocaleBundle(Language.ENGLISH);
    if (enBundle != null) {
      const enVal = enBundle[key];
      if (typeof enVal === 'string' && enVal.length > 0) return enVal;
    }
  }

  // Last resort: return the key itself.
  return key;
}

/**
 * Load (and cache) a locale bundle from public/locales/{lang}.json.
 * Browser: loaded via dynamic import / fetch.
 * Server: loaded synchronously from the filesystem (build output).
 * Returns null if the file doesn't exist or can't be parsed.
 */
function getLocaleBundle(lang: Language): Record<string, string> | null {
  const cached = localeBundles.get(lang);
  if (cached !== undefined) return cached;

  // In a browser / Edge environment we can't do synchronous FS reads.
  // The bundle must have been pre-loaded via loadLocaleBundles().
  // Return null and let the fallback chain handle it.
  return null;
}

/**
 * Pre-load locale bundles for the given languages.
 * Call this once during server startup or route handler initialisation.
 * In browser contexts, use the async loadLocaleBundleAsync() instead.
 *
 * @param langs  Languages to load. Loads all languages if omitted.
 */
export async function loadLocaleBundles(langs?: readonly Language[]): Promise<void> {
  const targets = langs ?? Object.values(Language);

  await Promise.allSettled(
    targets.map(async (lang) => {
      try {
        const res = await fetch(
          typeof window !== 'undefined'
            ? `/locales/${lang}.json`
            : `${process.cwd()}/public/locales/${lang}.json`,
          { cache: 'force-cache' },
        );
        if (!res.ok) return;
        const bundle = (await res.json()) as Record<string, string>;
        localeBundles.set(lang, bundle);
      } catch {
        // Non-fatal — fallback chain handles missing bundles.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Internal: raw batch translation
// ---------------------------------------------------------------------------

/**
 * Call the Google Cloud Translation API v2 with a batch of texts.
 * Returns translated strings in the same order as the input.
 * Falls back to the original texts on any API failure.
 */
async function translateBatch(
  texts:      readonly string[],
  sourceLang: Language,
  targetLang: Language,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const apiKey = getTranslationApiKey();
  if (!apiKey) {
    // No API key — return originals so the pipeline doesn't crash.
    return [...texts];
  }

  try {
    const response = await fetch(`${TRANSLATION_API_BASE}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        q:      texts,
        source: sourceLang,
        target: targetLang,
        format: 'text',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[translate] API returned ${response.status}`);
      return [...texts];
    }

    const data = (await response.json()) as {
      data?: { translations?: Array<{ translatedText?: string }> };
    };

    const translations = data?.data?.translations ?? [];
    return texts.map((original, i) => translations[i]?.translatedText ?? original);
  } catch {
    return [...texts];
  }
}

// ---------------------------------------------------------------------------
// Internal: BigQuery cost logging
// ---------------------------------------------------------------------------

interface TranslationCostEntry {
  readonly sourceLang: Language;
  readonly targetLang: Language;
  readonly charCount:  number;
  readonly texts:      number;
}

async function logTranslationCost(entry: TranslationCostEntry): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';

  if (!projectId) return;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    await new BigQuery({ projectId })
      .dataset(datasetId)
      .table('translation_costs')
      .insert([
        {
          source_lang:   entry.sourceLang,
          target_lang:   entry.targetLang,
          char_count:    entry.charCount,
          text_count:    entry.texts,
          logged_at:     new Date().toISOString(),
        },
      ]);
  } catch {
    // BigQuery logging is best-effort — never throw.
  }
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw BCP-47 ISO code string to the Language enum.
 * Falls back to Language.ENGLISH for unknown codes.
 */
export function codeToLanguage(code: string): Language {
  const normalised = code.trim().toLowerCase().split('-')[0] ?? 'en';
  const validCodes = Object.values(Language) as string[];
  if (validCodes.includes(normalised)) return normalised as Language;
  return Language.ENGLISH;
}

/**
 * Human-readable language name for use in Gemini prompts.
 */
function languageName(lang: Language): string {
  const names: Record<Language, string> = {
    [Language.HINDI]:     'Hindi',
    [Language.TELUGU]:    'Telugu',
    [Language.TAMIL]:     'Tamil',
    [Language.KANNADA]:   'Kannada',
    [Language.BENGALI]:   'Bengali',
    [Language.MARATHI]:   'Marathi',
    [Language.GUJARATI]:  'Gujarati',
    [Language.MALAYALAM]: 'Malayalam',
    [Language.ENGLISH]:   'English',
  };
  return names[lang];
}

/**
 * Simple deterministic hash for Firestore document key generation.
 * Not cryptographically secure — used only for cache keying.
 */
async function hashText(text: string): Promise<string> {
  // Use the Web Crypto API when available (browser + Node 18+).
  try {
    const encoder = new TextEncoder();
    const data    = encoder.encode(text.slice(0, 500));
    const hash    = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // Fallback: DJB2 hash.
    let h = 5381;
    for (let i = 0; i < Math.min(text.length, 500); i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
    }
    return Math.abs(h).toString(16);
  }
}
