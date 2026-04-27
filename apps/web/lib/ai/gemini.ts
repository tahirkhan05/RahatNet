/**
 * Server-side Gemini AI client for RahatNet.
 *
 * This module is server-only (API routes, Cloud Functions).
 * Never import it from 'use client' components.
 *
 * Key responsibilities:
 *  1. Typed JSON calls with automatic code-fence stripping.
 *  2. 30-second per-call timeout via AbortController.
 *  3. Exponential-backoff retry (3 attempts) on 429 / 503 / timeout.
 *  4. In-process token-bucket rate limiter (60 calls/min per Google limit).
 *  5. Token usage capture so callers can log cost to BigQuery.
 *  6. `callGeminiWithAudit` — returns both parsed value AND raw response
 *     text for the Firestore audit trail.
 *
 * Model: gemini-1.5-flash (fast, multimodal, cost-effective).
 * The model ID is a constant so a single change upgrades the entire pipeline.
 */

import {
  GoogleGenerativeAI,
  type GenerationConfig,
  type GenerateContentResult,
  type Part,
} from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GEMINI_MODEL = 'gemini-1.5-flash';

/**
 * Default generation config for structured JSON outputs.
 * Low temperature (0.1) minimises hallucination in schema-constrained responses.
 */
const JSON_GENERATION_CONFIG: GenerationConfig = {
  temperature:     0.1,
  topP:            0.9,
  topK:            40,
  maxOutputTokens: 2048,
};

/** For free-text narrative generation (canonical need descriptions). */
const TEXT_GENERATION_CONFIG: GenerationConfig = {
  temperature:     0.3,
  topP:            0.9,
  topK:            40,
  maxOutputTokens: 1024,
};

const CALL_TIMEOUT_MS    = 30_000;  // 30 s per call
const MAX_RETRIES        = 3;       // attempts before propagating the error

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (60 calls/min)
// ---------------------------------------------------------------------------

/**
 * In-process token bucket for the Gemini API rate limit.
 *
 * Google allows 60 requests per minute on the free tier.
 * The bucket refills at 1 token/second (60/60).
 * A call blocks (sleeps) until a token is available.
 *
 * This is module-level state — it is shared across all requests handled
 * by this Next.js server process.  On multi-instance deployments each
 * replica has its own counter, which is conservative (stays under limit).
 */
class GeminiRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private lastRefillTime: number;
  private readonly refillRatePerMs: number;

  constructor(callsPerMinute: number) {
    this.maxTokens        = callsPerMinute;
    this.tokens           = callsPerMinute;
    this.lastRefillTime   = Date.now();
    this.refillRatePerMs  = callsPerMinute / 60_000;
  }

  /** Acquire one token, sleeping until one is available. */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate how long until the next token is available.
    const msUntilToken = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    await sleep(msUntilToken);
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now         = Date.now();
    const elapsed     = now - this.lastRefillTime;
    const newTokens   = elapsed * this.refillRatePerMs;
    this.tokens       = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefillTime = now;
  }
}

const rateLimiter = new GeminiRateLimiter(60);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token usage returned by the Gemini API, captured for cost logging. */
export interface GeminiUsage {
  readonly promptTokens:     number;
  readonly candidateTokens:  number;
  readonly totalTokens:      number;
}

/** Return value of `callGeminiWithAudit` — parsed value + audit data. */
export interface GeminiAuditResult<T> {
  /** The parsed, typed value extracted from the response. */
  readonly value: T;
  /** Raw text of the Gemini response — stored in Firestore for debugging. */
  readonly rawResponse: string;
  /** Token usage for BigQuery cost logging. */
  readonly usage: GeminiUsage;
  /** Number of retries needed (0 = first attempt succeeded). */
  readonly retries: number;
  /** Wall-clock ms from call start to resolution. */
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      '[Gemini] GEMINI_API_KEY is not set. ' +
        'Add it to .env.local and to Secret Manager in GCP.',
    );
  }
  return new GoogleGenerativeAI(apiKey);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract token usage from a Gemini response.
 * Returns zeros if the metadata is absent (e.g. in older SDK versions).
 */
function extractUsage(result: GenerateContentResult): GeminiUsage {
  const meta = result.response.usageMetadata;
  return {
    promptTokens:    meta?.promptTokenCount    ?? 0,
    candidateTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens:     meta?.totalTokenCount      ?? 0,
  };
}

/**
 * Strip Markdown code fences that Gemini sometimes wraps around JSON output.
 *
 * Handles:
 *   ```json\n{...}\n```
 *   ```\n{...}\n```
 *   Plain {…} (no fences)
 */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
}

/**
 * Determine if a caught error is retryable (rate-limit or transient server error).
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('429') ||
    err.message.includes('503') ||
    err.message.includes('timeout') ||
    err.message.includes('RESOURCE_EXHAUSTED') ||
    err.message.includes('Service Unavailable')
  );
}

// ---------------------------------------------------------------------------
// Core call functions
// ---------------------------------------------------------------------------

/**
 * Call Gemini and return the parsed JSON value with full audit metadata.
 *
 * The function:
 *  1. Acquires a rate-limit token (blocks if needed).
 *  2. Builds the request Parts array (text + optional images).
 *  3. Races the API call against a 30-second timeout.
 *  4. Retries up to MAX_RETRIES times on 429/503/timeout with exponential backoff.
 *  5. Returns the parsed JSON value, raw response, token usage, and timing.
 *
 * @param prompt      Instruction text for Gemini.
 * @param imagesB64   Optional array of base64-encoded images (JPEG or PNG).
 * @param config      Optional overrides to the default GenerationConfig.
 */
export async function callGeminiWithAudit<T>(
  prompt: string,
  imagesB64: readonly string[] = [],
  config?: Partial<GenerationConfig>,
): Promise<GeminiAuditResult<T>> {
  const startMs   = Date.now();
  let   retries   = 0;
  let   lastError: Error = new Error('Gemini call failed');

  const client = getClient();
  const model  = client.getGenerativeModel({
    model:            GEMINI_MODEL,
    generationConfig: { ...JSON_GENERATION_CONFIG, ...config },
  });

  const parts: Part[] = [{ text: prompt }];
  for (const b64 of imagesB64) {
    // Detect MIME type from the base64 prefix (data:image/jpeg;base64,...).
    const mimeMatch = b64.match(/^data:(image\/[a-zA-Z+]+);base64,/);
    const mimeType  = (mimeMatch?.[1] ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
    const data      = mimeMatch ? b64.replace(/^data:[^;]+;base64,/, '') : b64;
    parts.push({ inlineData: { data, mimeType } });
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Acquire a rate-limit token before each attempt.
    await rateLimiter.acquire();

    try {
      const result = await Promise.race<GenerateContentResult>([
        model.generateContent(parts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini timeout after 30s')), CALL_TIMEOUT_MS),
        ),
      ]);

      const rawResponse = result.response.text();
      const jsonText    = stripCodeFences(rawResponse);
      const value       = JSON.parse(jsonText) as T;
      const usage       = extractUsage(result);

      return {
        value,
        rawResponse,
        usage,
        retries: attempt - 1,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryable(lastError) || attempt === MAX_RETRIES) break;

      // Exponential backoff: 2s, 4s, 8s …
      const backoffMs = Math.pow(2, attempt) * 1_000;
      await sleep(backoffMs);
      retries = attempt;
    }
  }

  throw lastError;
}

/**
 * Call Gemini for free-text output (no JSON parsing).
 * Used for generating narrative descriptions.
 */
export async function callGeminiText(
  prompt:   string,
  config?:  Partial<GenerationConfig>,
): Promise<{ text: string; usage: GeminiUsage; durationMs: number }> {
  const startMs = Date.now();
  const client  = getClient();
  const model   = client.getGenerativeModel({
    model:            GEMINI_MODEL,
    generationConfig: { ...TEXT_GENERATION_CONFIG, ...config },
  });

  await rateLimiter.acquire();

  const result      = await Promise.race<GenerateContentResult>([
    model.generateContent([{ text: prompt }]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout after 30s')), CALL_TIMEOUT_MS),
    ),
  ]);

  return {
    text:       result.response.text(),
    usage:      extractUsage(result),
    durationMs: Date.now() - startMs,
  };
}

/**
 * Legacy compatibility shim — used by other parts of the codebase.
 * Prefers `callGeminiWithAudit` for new code.
 */
export async function callGeminiJSON<T>(
  prompt:     string,
  imageBase64?: string,
  config?:    Partial<GenerationConfig>,
): Promise<T> {
  const images = imageBase64 != null ? [imageBase64] : [];
  const result = await callGeminiWithAudit<T>(prompt, images, config);
  return result.value;
}
