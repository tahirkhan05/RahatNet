/**
 * In-process sliding-window rate limiter for Next.js API routes.
 *
 * Uses a module-level Map as the store so it works without any external
 * infrastructure (no Redis, no Upstash account needed).  This is the right
 * trade-off for a hackathon / initial launch:
 *
 *   ✓ Zero latency — pure in-process, no network hop
 *   ✓ Zero infrastructure — works on Firebase Hosting, Vercel, and locally
 *   ✗ Not shared across instances — if you deploy 3 replicas each has its own
 *     counter.  Swap `LruStore` for an Upstash client when you need distributed
 *     rate limiting.
 *
 * Algorithm: sliding-window log.
 *   For each key (IP address), maintain a sorted array of request timestamps.
 *   On each request, evict timestamps older than the window, then count the
 *   remaining.  If count >= limit, reject.
 *
 * The store is bounded by MAX_STORE_SIZE to prevent unbounded memory growth
 * from a large number of distinct IPs.  LRU eviction removes the
 * least-recently-used key when the limit is reached.
 *
 * Usage:
 *   const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
 *   const result = await limiter.check(request);
 *   if (!result.allowed) {
 *     return rateLimitedResponse(result);
 *   }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { ApiResponse } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// LRU store
// ---------------------------------------------------------------------------

const MAX_STORE_SIZE = 5_000;

/**
 * Minimal LRU cache backed by an insertion-ordered Map.
 * Evicts the oldest key (Map insertion order) when full.
 */
class LruStore {
  private readonly store = new Map<string, number[]>();

  get(key: string): number[] | undefined {
    const value = this.store.get(key);
    if (value !== undefined) {
      // Move to end (most-recently-used) by re-inserting.
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.store.size >= MAX_STORE_SIZE && !this.store.has(key)) {
      // Evict the LRU entry (first key in insertion order).
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
    this.store.delete(key);
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
  /**
   * Maximum number of requests allowed per window per key.
   * @default 10
   */
  limit: number;
  /**
   * Window duration in milliseconds.
   * @default 60_000  (1 minute)
   */
  windowMs: number;
  /**
   * Key prefix to namespace multiple limiters in the same store.
   * @default 'rl'
   */
  prefix?: string;
}

export interface RateLimitResult {
  /** Whether this request is within the rate limit. */
  readonly allowed: boolean;
  /** Remaining requests in the current window. */
  readonly remaining: number;
  /** Total requests allowed per window. */
  readonly limit: number;
  /**
   * Unix timestamp (ms) when the oldest request in the window expires.
   * Can be converted to `Retry-After` seconds: `Math.ceil((resetAt - Date.now()) / 1000)`.
   * Undefined when no requests have been made yet.
   */
  readonly resetAt: number | undefined;
}

/**
 * Create a rate limiter instance.
 *
 * Each call to `createRateLimiter` creates an independent store, so different
 * routes have independent counters.  Share an instance to share counters.
 */
export function createRateLimiter(config: RateLimiterConfig) {
  const { limit, windowMs, prefix = 'rl' } = config;
  const store = new LruStore();

  return {
    /**
     * Check the rate limit for the given key (typically an IP address).
     * Records the current request and returns the result.
     *
     * @param key  - any string that identifies the caller, e.g. an IP address
     */
    check(key: string): RateLimitResult {
      const storeKey = `${prefix}:${key}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Retrieve existing timestamps, evicting expired ones.
      const timestamps = (store.get(storeKey) ?? []).filter((t) => t > windowStart);

      const remaining = Math.max(0, limit - timestamps.length - 1);
      const resetAt = timestamps.length > 0 ? timestamps[0] : undefined;

      if (timestamps.length >= limit) {
        // Record request attempted but rejected (don't add the timestamp —
        // adding it would shift the window and let a DDoS compress the reset time).
        store.set(storeKey, timestamps);
        return { allowed: false, remaining: 0, limit, resetAt };
      }

      // Record this request.
      timestamps.push(now);
      store.set(storeKey, timestamps);
      return { allowed: true, remaining, limit, resetAt };
    },

    /**
     * Peek at the current rate-limit state without recording a request.
     * Useful for building status endpoints.
     */
    peek(key: string): RateLimitResult {
      const storeKey = `${prefix}:${key}`;
      const now = Date.now();
      const windowStart = now - windowMs;
      const timestamps = (store.get(storeKey) ?? []).filter((t) => t > windowStart);
      const remaining = Math.max(0, limit - timestamps.length);
      return { allowed: timestamps.length < limit, remaining, limit, resetAt: timestamps[0] };
    },
  };
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

/**
 * Extract the best available IP address from a Next.js request.
 *
 * Priority:
 *  1. CF-Connecting-IP (Cloudflare)
 *  2. X-Forwarded-For first IP (Vercel, most reverse proxies)
 *  3. X-Real-IP (Nginx)
 *  4. Literal string 'unknown' — will share a single bucket across all unknown IPs,
 *     which is conservative (limits all unknown callers together).
 */
export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

/**
 * Build the standard 429 Too Many Requests response for a rate-limited caller.
 *
 * @param result     - the failed RateLimitResult
 * @param requestId  - correlation ID for this request
 */
export function rateLimitedResponse(
  result: RateLimitResult,
  requestId: string,
): NextResponse<ApiResponse<never>> {
  const retryAfterSecs =
    result.resetAt !== undefined
      ? Math.ceil((result.resetAt + (60_000) - Date.now()) / 1_000)
      : 60;

  return NextResponse.json(
    {
      success: false as const,
      data: null,
      error: {
        code: 'RATE_LIMITED' as const,
        message: `Too many requests. Please wait ${retryAfterSecs} seconds and try again.`,
        statusCode: 429,
      },
      requestId,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSecs),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
        ...(result.resetAt != null
          ? { 'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1_000)) }
          : {}),
      },
    },
  );
}
