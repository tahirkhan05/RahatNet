/**
 * Structured logger for the Firebase client library.
 *
 * In development, writes human-readable lines to the console.
 * In production, emits JSON objects that can be ingested by Cloud Logging
 * (when running on Firebase Hosting / Cloud Run the stdout is forwarded).
 *
 * Every log entry carries:
 *   operation  – the function name (e.g. 'getDocument', 'uploadNeedPhoto')
 *   module     – the source file  (e.g. 'firestore', 'storage')
 *   requestId  – optional correlation ID threaded through from the caller
 *   userId     – optional Firebase Auth UID
 *   extra      – arbitrary key→value pairs specific to the call
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly module: string;
  readonly operation: string;
  readonly message: string;
  readonly requestId?: string;
  readonly userId?: string;
  readonly durationMs?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  };
}

const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * Emit a structured log entry.
 * Callers should prefer the module-scoped logger returned by `createLogger`.
 */
export function log(entry: LogEntry): void {
  if (typeof window === 'undefined') {
    // SSR context — skip client-side logs
    return;
  }

  if (IS_DEV) {
    const prefix = `[Firebase:${entry.module}] ${entry.operation}`;
    const meta = [
      entry.requestId != null ? `rid=${entry.requestId}` : null,
      entry.userId != null ? `uid=${entry.userId.slice(0, 8)}…` : null,
      entry.durationMs != null ? `${entry.durationMs}ms` : null,
    ]
      .filter(Boolean)
      .join(' ');

    const line = meta.length > 0 ? `${prefix} (${meta}) — ${entry.message}` : `${prefix} — ${entry.message}`;

    switch (entry.level) {
      case 'debug':
        // Only show debug in dev and only when explicitly enabled
        if (process.env['NEXT_PUBLIC_DEBUG_FIREBASE'] === 'true') {
          console.debug(line, entry.extra ?? '');
        }
        break;
      case 'info':
        console.info(line, entry.extra ?? '');
        break;
      case 'warn':
        console.warn(line, entry.extra ?? '', entry.error ?? '');
        break;
      case 'error':
        console.error(line, entry.error ?? '', entry.extra ?? '');
        break;
    }
  } else {
    // Production: emit a single JSON line for Cloud Logging ingestion.
    const jsonEntry = {
      severity: entry.level.toUpperCase(),
      message: entry.message,
      module: `firebase.${entry.module}`,
      operation: entry.operation,
      ...(entry.requestId != null && { 'logging.googleapis.com/trace': entry.requestId }),
      ...(entry.userId != null && { userId: entry.userId }),
      ...(entry.durationMs != null && { durationMs: entry.durationMs }),
      ...(entry.extra != null && entry.extra),
      ...(entry.error != null && {
        error: entry.error,
      }),
    };

    // Only log warn/error in production to reduce noise and egress costs.
    if (entry.level === 'warn') {
      console.warn(JSON.stringify(jsonEntry));
    } else if (entry.level === 'error') {
      console.error(JSON.stringify(jsonEntry));
    }
  }
}

/**
 * Options passed to every logged call.
 * All fields are optional — callers supply whatever context they have.
 */
export interface LogContext {
  requestId?: string;
  userId?: string;
}

/**
 * Factory that binds a module name so call sites don't repeat it.
 *
 * @example
 * const logger = createLogger('firestore');
 * logger.info('getDocument', 'cache hit', { collection: 'needs' });
 */
export function createLogger(module: string) {
  return {
    debug(operation: string, message: string, extra?: LogEntry['extra'], ctx?: LogContext): void {
      log({ level: 'debug', module, operation, message, extra, ...ctx });
    },
    info(operation: string, message: string, extra?: LogEntry['extra'], ctx?: LogContext): void {
      log({ level: 'info', module, operation, message, extra, ...ctx });
    },
    warn(
      operation: string,
      message: string,
      error?: LogEntry['error'],
      extra?: LogEntry['extra'],
      ctx?: LogContext,
    ): void {
      log({ level: 'warn', module, operation, message, error, extra, ...ctx });
    },
    error(
      operation: string,
      message: string,
      error?: LogEntry['error'],
      extra?: LogEntry['extra'],
      ctx?: LogContext,
    ): void {
      log({ level: 'error', module, operation, message, error, extra, ...ctx });
    },
    timed<T>(
      operation: string,
      fn: () => Promise<T>,
      ctx?: LogContext,
    ): Promise<T> {
      const start = Date.now();
      return fn().then(
        (result) => {
          log({
            level: 'debug',
            module,
            operation,
            message: 'completed',
            durationMs: Date.now() - start,
            ...ctx,
          });
          return result;
        },
        (err: unknown) => {
          log({
            level: 'error',
            module,
            operation,
            message: 'failed',
            durationMs: Date.now() - start,
            error:
              err instanceof Error
                ? { name: err.name, message: err.message, code: (err as { code?: string }).code }
                : { name: 'UnknownError', message: String(err) },
            ...ctx,
          });
          throw err;
        },
      );
    },
  };
}
