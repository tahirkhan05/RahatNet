/**
 * Server-side structured logger for Next.js API routes and server modules.
 *
 * Writes to stdout so entries are captured by:
 *   - Firebase Hosting / Cloud Run → Google Cloud Logging
 *   - Vercel → Vercel Log Drains
 *   - Local dev → terminal
 *
 * Unlike the client logger (lib/firebase/logger.ts), this module has no
 * `typeof window` guard — it is only ever imported in server contexts
 * (API routes, middleware, lib/firebase/admin.ts).
 *
 * Every log entry follows the Google Cloud Logging JSON format so that
 * `severity`, `httpRequest`, and `logging.googleapis.com/trace` are
 * surfaced correctly in the Cloud Console.
 *
 * Usage:
 *   const logger = createServerLogger('auth');
 *   logger.info('verifyToken', 'token verified', { uid }, { requestId });
 */

export type ServerLogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface ServerLogEntry {
  readonly severity: ServerLogLevel;
  readonly message: string;
  readonly module: string;
  readonly operation: string;
  readonly requestId?: string;
  readonly userId?: string;
  readonly durationMs?: number;
  readonly httpRequest?: {
    readonly requestMethod?: string;
    readonly status?: number;
    readonly remoteIp?: string;
  };
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly stack?: string;
  };
  readonly [key: string]: unknown;
}

const IS_DEV = process.env.NODE_ENV === 'development';

function emit(entry: ServerLogEntry): void {
  if (IS_DEV) {
    // Human-readable format for local development.
    const meta = [
      entry.requestId != null ? `rid=${entry.requestId.slice(0, 8)}` : null,
      entry.userId != null ? `uid=${entry.userId.slice(0, 8)}…` : null,
      entry.durationMs != null ? `${entry.durationMs}ms` : null,
    ]
      .filter(Boolean)
      .join(' ');

    const prefix = `[${entry.severity}] [${entry.module}:${entry.operation}]`;
    const suffix = meta.length > 0 ? ` (${meta})` : '';
    const line = `${prefix}${suffix} ${entry.message}`;

    switch (entry.severity) {
      case 'DEBUG':
        // Only show if explicitly enabled — reduces noise during local dev.
        if (process.env['DEBUG_SERVER_LOGS'] === 'true') {
          console.debug(line, entry.error ?? '');
        }
        break;
      case 'INFO':
        console.info(line);
        break;
      case 'WARNING':
        console.warn(line, entry.error ?? '');
        break;
      case 'ERROR':
      case 'CRITICAL':
        console.error(line, entry.error ?? '');
        break;
    }
  } else {
    // Production: single JSON line per entry.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }
}

export interface ServerLogContext {
  requestId?: string;
  userId?: string;
  remoteIp?: string;
  httpMethod?: string;
}

/**
 * Create a module-scoped server logger.
 *
 * @param module - short identifier for the source file, e.g. 'admin', 'session'
 */
export function createServerLogger(module: string) {
  return {
    debug(
      operation: string,
      message: string,
      extra?: Record<string, unknown>,
      ctx?: ServerLogContext,
    ): void {
      emit({ severity: 'DEBUG', module, operation, message, ...ctx, ...extra });
    },

    info(
      operation: string,
      message: string,
      extra?: Record<string, unknown>,
      ctx?: ServerLogContext,
    ): void {
      emit({ severity: 'INFO', module, operation, message, ...ctx, ...extra });
    },

    warn(
      operation: string,
      message: string,
      error?: ServerLogEntry['error'],
      extra?: Record<string, unknown>,
      ctx?: ServerLogContext,
    ): void {
      emit({ severity: 'WARNING', module, operation, message, error, ...ctx, ...extra });
    },

    error(
      operation: string,
      message: string,
      error?: ServerLogEntry['error'],
      extra?: Record<string, unknown>,
      ctx?: ServerLogContext,
    ): void {
      emit({ severity: 'ERROR', module, operation, message, error, ...ctx, ...extra });
    },

    critical(
      operation: string,
      message: string,
      error?: ServerLogEntry['error'],
      extra?: Record<string, unknown>,
      ctx?: ServerLogContext,
    ): void {
      emit({ severity: 'CRITICAL', module, operation, message, error, ...ctx, ...extra });
    },

    /**
     * Time an async operation, logging start → result with elapsed ms.
     * Always re-throws on failure so the caller's error handling is unaffected.
     */
    async timed<T>(
      operation: string,
      fn: () => Promise<T>,
      ctx?: ServerLogContext,
    ): Promise<T> {
      const start = Date.now();
      try {
        const result = await fn();
        emit({
          severity: 'DEBUG',
          module,
          operation,
          message: 'completed',
          durationMs: Date.now() - start,
          ...ctx,
        });
        return result;
      } catch (err) {
        emit({
          severity: 'ERROR',
          module,
          operation,
          message: 'failed',
          durationMs: Date.now() - start,
          error:
            err instanceof Error
              ? {
                  name: err.name,
                  message: err.message,
                  code: (err as { code?: string }).code,
                }
              : { name: 'UnknownError', message: String(err) },
          ...ctx,
        });
        throw err;
      }
    },
  };
}

/** Extract a safe error shape from any thrown value. */
export function toLogError(err: unknown): ServerLogEntry['error'] {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: (err as { code?: string }).code,
      // Only include stack in development — stacks in production logs are verbose.
      ...(IS_DEV && err.stack != null ? { stack: err.stack } : {}),
    };
  }
  return { name: 'UnknownError', message: String(err) };
}
