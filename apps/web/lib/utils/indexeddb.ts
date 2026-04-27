/**
 * IndexedDB helpers for RahatNet offline storage.
 *
 * Uses the `idb` wrapper library (https://github.com/jakearchibald/idb) so
 * we get Promise-based access and typed stores without raw IDB boilerplate
 * in component code.
 *
 * Database:  rahatnet
 * Version:   1
 * Stores:
 *   pendingReports  – reports queued while offline (keyPath: id, index: queuedAt)
 *
 * Schema migration strategy:
 *   Bump DB_VERSION and add a new `case` in the upgrade() switch to apply the
 *   migration.  The switch falls through from the current version to the new
 *   one, so each upgrade function runs exactly once.
 *
 *   Example for v2 (add a 'syncedReports' audit store):
 *
 *     case 1:
 *       // Migration from v1 → v2
 *       db.createObjectStore('syncedReports', { keyPath: 'id' });
 *       // falls through ↓
 *     case 2:
 *       // At latest version — nothing to do.
 *       break;
 *
 * Error handling:
 *   All functions throw a typed `IdbError` so callers can distinguish IDB
 *   failures from network/server failures without catching plain `Error`.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { NeedType } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Schema constants — bump DB_VERSION when the schema changes
// ---------------------------------------------------------------------------

const DB_NAME    = 'rahatnet';
const DB_VERSION = 1;

const STORES = {
  PENDING_REPORTS: 'pendingReports',
} as const;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * A need report queued for later submission while offline.
 * Fields mirror the POST /api/needs body plus queue metadata.
 */
export interface PendingReport {
  /** UUID assigned client-side when the report is created. */
  readonly id: string;
  readonly type: NeedType;
  readonly description: string;
  readonly originalDescription: string;
  readonly originalLanguage: string;
  /** base64 data URL or Firebase Storage URL */
  readonly voiceNoteUrl: string | null;
  readonly photoUrls: readonly string[];
  readonly location: { readonly lat: number; readonly lng: number };
  readonly locationName: string;
  readonly affectedCount: number;
  readonly hasVulnerable: boolean;
  readonly disasterEventId: string;
  /** Unix millisecond timestamp when the report was queued. */
  readonly queuedAt: number;
  /** Number of send attempts that have failed so far. */
  readonly retryCount: number;
}

// ---------------------------------------------------------------------------
// Custom error type
// ---------------------------------------------------------------------------

export class IdbError extends Error {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    super(
      `IndexedDB ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'IdbError';
    if (cause instanceof Error && cause.stack != null) {
      this.stack = `${this.stack ?? ''}\nCaused by: ${cause.stack}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton DB connection
// ---------------------------------------------------------------------------

/** Module-level promise so we never open the database twice. */
let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * Returns the shared IDBPDatabase instance, opening it on first call.
 * Subsequent calls return the same promise (cached).
 *
 * @throws {IdbError} when the database cannot be opened.
 */
function getDB(): Promise<IDBPDatabase> {
  if (dbPromise !== null) return dbPromise;

  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Migrations run sequentially from oldVersion to DB_VERSION.
      // Use a switch with deliberate fall-through for multi-step upgrades.
      switch (oldVersion) {
        case 0: {
          // Fresh install: create the pendingReports store.
          const store = db.createObjectStore(STORES.PENDING_REPORTS, {
            keyPath: 'id',
          });
          // Index on queuedAt so we can drain in submission order.
          store.createIndex('queuedAt', 'queuedAt', { unique: false });
          break;
        }
        default:
          // Already at DB_VERSION — nothing more to do.
          break;
      }
    },
    blocked() {
      // Another tab is holding an older version open.
      // We can't upgrade until it closes — warn the developer.
      console.warn(
        '[IDB] Database upgrade blocked. Close other RahatNet tabs to proceed.',
      );
    },
    blocking() {
      // This tab is blocking another one from upgrading.
      // Close our connection so the other tab can proceed.
      dbPromise = null;
    },
    terminated() {
      // The browser forcibly closed the connection (e.g. low storage).
      // Reset so the next call re-opens it.
      dbPromise = null;
    },
  }).catch((err: unknown) => {
    // Reset the cached promise so future calls try again.
    dbPromise = null;
    throw new IdbError('open', err);
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Save a pending report to the offline queue.
 *
 * `queuedAt` and `retryCount` are set automatically — do not include them
 * in the `report` argument.
 *
 * @throws {IdbError}
 */
export async function savePendingReport(
  report: Omit<PendingReport, 'queuedAt' | 'retryCount'>,
): Promise<void> {
  try {
    const db = await getDB();
    await db.put(STORES.PENDING_REPORTS, {
      ...report,
      queuedAt:   Date.now(),
      retryCount: 0,
    } satisfies PendingReport);
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('savePendingReport', err);
  }
}

/**
 * Return all pending reports ordered by queue time (oldest first).
 *
 * @throws {IdbError}
 */
export async function getPendingReports(): Promise<PendingReport[]> {
  try {
    const db = await getDB();
    // getAllFromIndex returns records sorted by the index value (queuedAt asc).
    return (await db.getAllFromIndex(
      STORES.PENDING_REPORTS,
      'queuedAt',
    )) as PendingReport[];
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('getPendingReports', err);
  }
}

/**
 * Return a single pending report by ID, or `undefined` if not found.
 *
 * @throws {IdbError}
 */
export async function getPendingReport(id: string): Promise<PendingReport | undefined> {
  try {
    const db = await getDB();
    return (await db.get(STORES.PENDING_REPORTS, id)) as PendingReport | undefined;
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('getPendingReport', err);
  }
}

/**
 * Delete a pending report by ID (called after successful submission).
 *
 * @throws {IdbError}
 */
export async function deletePendingReport(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(STORES.PENDING_REPORTS, id);
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('deletePendingReport', err);
  }
}

/**
 * Perform a full record update on a pending report.
 * Use this to update the `retryCount` or any other mutable field.
 *
 * The record must already exist (this is a replace, not an upsert).
 *
 * @throws {IdbError} when the record does not exist or the write fails.
 */
export async function updatePendingReport(
  id:      string,
  patch:   Partial<Omit<PendingReport, 'id'>>,
): Promise<void> {
  try {
    const db     = await getDB();
    const existing = (await db.get(
      STORES.PENDING_REPORTS,
      id,
    )) as PendingReport | undefined;

    if (existing === undefined) {
      throw new IdbError(
        'updatePendingReport',
        `Report "${id}" not found in pending queue`,
      );
    }

    await db.put(STORES.PENDING_REPORTS, { ...existing, ...patch, id });
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('updatePendingReport', err);
  }
}

/**
 * Convenience wrapper: increment the retry counter by 1.
 * Creates a typed update so the caller doesn't need to read → modify → write.
 *
 * @throws {IdbError}
 */
export async function incrementRetryCount(id: string): Promise<void> {
  try {
    const db       = await getDB();
    const existing = (await db.get(
      STORES.PENDING_REPORTS,
      id,
    )) as PendingReport | undefined;

    if (existing === undefined) return; // Already removed — nothing to do.

    await db.put(STORES.PENDING_REPORTS, {
      ...existing,
      retryCount: existing.retryCount + 1,
    });
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('incrementRetryCount', err);
  }
}

/**
 * Delete ALL pending reports.
 *
 * Used by:
 *   - The demo seed clear script (scripts/clear-demo.ts).
 *   - A manual "clear queue" button in debug/settings UI.
 *
 * @throws {IdbError}
 */
export async function clearAllPendingReports(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(STORES.PENDING_REPORTS);
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('clearAllPendingReports', err);
  }
}

/**
 * Return the count of pending reports without loading their full payloads.
 * Slightly more efficient than `getPendingReports().length` for badge counts.
 *
 * @throws {IdbError}
 */
export async function getPendingReportCount(): Promise<number> {
  try {
    const db = await getDB();
    return await db.count(STORES.PENDING_REPORTS);
  } catch (err) {
    if (err instanceof IdbError) throw err;
    throw new IdbError('getPendingReportCount', err);
  }
}
