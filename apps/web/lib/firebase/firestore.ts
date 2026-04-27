'use client';

/**
 * Firestore client library — typed CRUD + realtime subscriptions.
 *
 * Design decisions:
 *
 * 1. Persistence
 *    `initializeFirestore` with `persistentLocalCache` is used instead of the
 *    deprecated `enableIndexedDbPersistence`.  Multi-tab persistence is enabled
 *    so data is shared between browser tabs (war-room has multiple open tabs).
 *
 * 2. Retry logic
 *    Write operations (set, update, add, delete) retry up to MAX_WRITE_RETRIES
 *    times with exponential backoff.  Read operations are not retried — they
 *    fail fast so the UI can show an offline state.
 *
 *    Retryable Firestore error codes:
 *      'unavailable'       — server unreachable (network issue)
 *      'resource-exhausted' — quota / rate-limit (back off and retry)
 *      'deadline-exceeded' — operation timed out
 *      'aborted'           — transaction conflict (retry is safe for non-tx writes)
 *
 * 3. Error normalisation
 *    All FirestoreError instances are mapped to AppError with user-facing
 *    messages so UI components get a consistent interface.
 *
 * 4. Logging
 *    Every operation logs start, result, and duration via the structured logger.
 *    Subscription errors are logged without throwing (Firestore will retry).
 *
 * 5. Type safety
 *    Generics are constrained to `DocumentData` so callers get typed results
 *    without casting.  The `id` field is always injected from the snapshot.
 */

import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  collection,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  setDoc as fsSetDoc,
  updateDoc as fsUpdateDoc,
  deleteDoc as fsDeleteDoc,
  addDoc as fsAddDoc,
  onSnapshot,
  query,
  serverTimestamp,
  type DocumentData,
  type Firestore,
  type QueryConstraint,
  type Unsubscribe,
  type WithFieldValue,
  type PartialWithFieldValue,
  type FirestoreError,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { firebaseApp } from './client';
import { AppError } from '@/lib/utils/errors';
import { COLLECTIONS } from '@rahatnet/types';
import { createLogger } from './logger';
import type { LogContext } from './logger';

// ---------------------------------------------------------------------------
// Firestore singleton with multi-tab offline persistence
// ---------------------------------------------------------------------------

/**
 * Initialise Firestore with the persistent multi-tab cache.
 * `initializeFirestore` must be called before `getFirestore` — using it here
 * instead of `getFirestore` ensures the cache config is applied exactly once.
 *
 * Wrapped in a try-catch so SSR (where IndexedDB is unavailable) doesn't crash.
 */
function createFirestoreClient(): Firestore {
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (err) {
    // initializeFirestore throws if called after getFirestore on the same app.
    // This happens in development with HMR — fall back to the already-configured instance.
    const { getFirestore } = require('firebase/firestore') as typeof import('firebase/firestore');
    return getFirestore(firebaseApp);
  }
}

export const db: Firestore = createFirestoreClient();

const logger = createLogger('firestore');

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_WRITE_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/** Firestore error codes that are safe to retry. */
const RETRYABLE_CODES = new Set<string>([
  'unavailable',
  'resource-exhausted',
  'deadline-exceeded',
  'aborted',
]);

function isRetryable(err: unknown): boolean {
  const code = (err as Partial<FirestoreError>).code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

function backoffMs(attempt: number): number {
  // Exponential backoff with ±25% jitter to prevent thundering herd.
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Execute a write operation, retrying on transient errors.
 *
 * @param operation  - label for logging
 * @param fn         - the async write to execute
 * @param ctx        - logging context
 */
async function withWriteRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  ctx?: LogContext,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        logger.info(operation, `succeeded on attempt ${attempt}`, undefined, ctx);
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_WRITE_RETRIES) break;

      const delay = backoffMs(attempt);
      logger.warn(
        operation,
        `attempt ${attempt} failed — retrying in ${delay}ms`,
        normaliseFirestoreError(err),
        undefined,
        ctx,
      );
      await sleep(delay);
    }
  }

  throw normaliseAppError(lastErr, operation);
}

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

const FIRESTORE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'permission-denied': 'You do not have permission to perform this action.',
  'not-found': 'The requested item does not exist.',
  'already-exists': 'This item already exists.',
  unavailable: 'Service temporarily unavailable. Please try again.',
  'resource-exhausted': 'Too many requests. Please try again shortly.',
  'deadline-exceeded': 'The request timed out. Please try again.',
  unauthenticated: 'You must be signed in to perform this action.',
  cancelled: 'The operation was cancelled.',
  'data-loss': 'A data error occurred. Please contact support.',
  'failed-precondition':
    'The operation could not be completed due to the current state of the data.',
};

function normaliseFirestoreError(err: unknown): { name: string; message: string; code?: string } {
  const fe = err as Partial<FirestoreError>;
  return {
    name: fe.name ?? 'FirestoreError',
    message: fe.message ?? String(err),
    code: fe.code,
  };
}

function normaliseAppError(err: unknown, operation: string): AppError {
  if (err instanceof AppError) return err;
  const fe = err as Partial<FirestoreError>;
  const code = fe.code ?? 'internal';
  const userMessage =
    FIRESTORE_ERROR_MESSAGES[code] ??
    'An unexpected database error occurred. Please try again.';

  logger.error(operation, 'Firestore error', normaliseFirestoreError(err));
  return new AppError('FIRESTORE_ERROR', userMessage, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Firestore DocumentSnapshot to a typed object, injecting `id`.
 * Returns null when the document does not exist.
 */
function docToTyped<T extends DocumentData>(snap: DocumentSnapshot): T | null {
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as unknown as T;
}

/**
 * Convert a Firestore QuerySnapshot to a typed array, injecting `id` on each.
 */
function queryToTyped<T extends DocumentData>(snap: QuerySnapshot): T[] {
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as T);
}

// ---------------------------------------------------------------------------
// Read operations (no retry — fail fast so UI shows offline state)
// ---------------------------------------------------------------------------

/**
 * Fetch a single document by collection name and document ID.
 *
 * @returns The typed document with an injected `id` field, or `null` when absent.
 * @throws {AppError} on permission or network error.
 *
 * @example
 * const need = await getDocument<CanonicalNeed>(COLLECTIONS.NEEDS, needId);
 */
export async function getDocument<T extends DocumentData>(
  collectionName: string,
  id: string,
  ctx?: LogContext,
): Promise<T | null> {
  logger.debug('getDocument', 'reading', { collection: collectionName, id }, ctx);
  try {
    const snap = await fsGetDoc(doc(db, collectionName, id));
    const result = docToTyped<T>(snap);
    logger.debug('getDocument', result ? 'found' : 'not found', { collection: collectionName, id }, ctx);
    return result;
  } catch (err) {
    throw normaliseAppError(err, 'getDocument');
  }
}

/**
 * Query a collection with one or more Firestore `QueryConstraint`s.
 *
 * @returns Typed array (may be empty — never null).
 * @throws {AppError} on error.
 *
 * @example
 * import { where, orderBy, limit } from 'firebase/firestore';
 * const needs = await getDocuments<CanonicalNeed>(
 *   COLLECTIONS.NEEDS,
 *   { userId: 'abc' },
 *   where('status', '==', 'VERIFIED'),
 *   orderBy('urgencyScore', 'desc'),
 *   limit(20),
 * );
 */
export async function getDocuments<T extends DocumentData>(
  collectionName: string,
  ctx: LogContext | undefined,
  ...constraints: QueryConstraint[]
): Promise<T[]> {
  logger.debug('getDocuments', 'querying', { collection: collectionName }, ctx);
  try {
    const q = query(collection(db, collectionName), ...constraints);
    const snap = await fsGetDocs(q);
    const results = queryToTyped<T>(snap);
    logger.debug('getDocuments', `returned ${results.length} docs`, { collection: collectionName }, ctx);
    return results;
  } catch (err) {
    throw normaliseAppError(err, 'getDocuments');
  }
}

// ---------------------------------------------------------------------------
// Write operations (with exponential-backoff retry)
// ---------------------------------------------------------------------------

/**
 * Create or fully overwrite a document by ID.
 * Retries up to 3 times on transient failures.
 *
 * @example
 * await setDocument<CanonicalNeed>(COLLECTIONS.NEEDS, need.id, need);
 */
export async function setDocument<T extends DocumentData>(
  collectionName: string,
  id: string,
  data: WithFieldValue<T>,
  ctx?: LogContext,
): Promise<void> {
  logger.debug('setDocument', 'writing', { collection: collectionName, id }, ctx);
  await withWriteRetry(
    'setDocument',
    () => fsSetDoc(doc(db, collectionName, id), data),
    ctx,
  );
  logger.debug('setDocument', 'written', { collection: collectionName, id }, ctx);
}

/**
 * Partially update an existing document.
 * The document must already exist — use `setDocument` for upserts.
 * Retries up to 3 times on transient failures.
 *
 * @example
 * await updateDocument<CanonicalNeed>(COLLECTIONS.NEEDS, need.id, {
 *   status: NeedStatus.ASSIGNED,
 *   assignedVolunteerId: volunteerId,
 *   updatedAt: serverTimestamp(),
 * });
 */
export async function updateDocument<T extends DocumentData>(
  collectionName: string,
  id: string,
  data: PartialWithFieldValue<T>,
  ctx?: LogContext,
): Promise<void> {
  logger.debug('updateDocument', 'updating', { collection: collectionName, id }, ctx);
  await withWriteRetry(
    'updateDocument',
    () => fsUpdateDoc(doc(db, collectionName, id), data as DocumentData),
    ctx,
  );
  logger.debug('updateDocument', 'updated', { collection: collectionName, id }, ctx);
}

/**
 * Delete a document by collection name and document ID.
 * Retries up to 3 times on transient failures.
 */
export async function deleteDocument(
  collectionName: string,
  id: string,
  ctx?: LogContext,
): Promise<void> {
  logger.debug('deleteDocument', 'deleting', { collection: collectionName, id }, ctx);
  await withWriteRetry(
    'deleteDocument',
    () => fsDeleteDoc(doc(db, collectionName, id)),
    ctx,
  );
  logger.debug('deleteDocument', 'deleted', { collection: collectionName, id }, ctx);
}

/**
 * Add a document to a collection with an auto-generated ID.
 *
 * @returns The Firestore-assigned document ID.
 * Retries up to 3 times on transient failures.
 *
 * @example
 * const reportId = await addDocument<RawReport>(COLLECTIONS.RAW_REPORTS, reportData);
 */
export async function addDocument<T extends DocumentData>(
  collectionName: string,
  data: WithFieldValue<T>,
  ctx?: LogContext,
): Promise<string> {
  logger.debug('addDocument', 'adding', { collection: collectionName }, ctx);
  const id = await withWriteRetry(
    'addDocument',
    async () => {
      const ref = await fsAddDoc(collection(db, collectionName), data);
      return ref.id;
    },
    ctx,
  );
  logger.debug('addDocument', 'added', { collection: collectionName, id }, ctx);
  return id;
}

// ---------------------------------------------------------------------------
// Realtime subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single document in real time.
 *
 * The callback fires immediately with the current value, then on every
 * server-side change.  Errors are logged but do not throw — Firestore
 * will reconnect automatically after transient failures.
 *
 * @returns Unsubscribe function — call on component unmount.
 *
 * @example
 * const unsub = subscribeToDocument<CanonicalNeed>(
 *   COLLECTIONS.NEEDS, needId, (need) => setNeed(need),
 * );
 */
export function subscribeToDocument<T extends DocumentData>(
  collectionName: string,
  id: string,
  callback: (data: T | null) => void,
  ctx?: LogContext,
): Unsubscribe {
  logger.debug('subscribeToDocument', 'subscribing', { collection: collectionName, id }, ctx);

  return onSnapshot(
    doc(db, collectionName, id),
    (snap) => {
      callback(docToTyped<T>(snap));
    },
    (err) => {
      logger.error(
        'subscribeToDocument',
        'snapshot error',
        normaliseFirestoreError(err),
        { collection: collectionName, id },
        ctx,
      );
      // Do NOT call callback with null here — Firestore will recover and
      // call onNext again when the connection is restored.
    },
  );
}

/**
 * Subscribe to a Firestore collection query in real time.
 *
 * Constraints are Firestore `QueryConstraint` values: `where`, `orderBy`,
 * `limit`, etc.  Errors are logged without throwing.
 *
 * @returns Unsubscribe function.
 *
 * @example
 * import { where, orderBy } from 'firebase/firestore';
 * const unsub = subscribeToDocuments<CanonicalNeed>(
 *   COLLECTIONS.NEEDS,
 *   (needs) => setNeeds(needs),
 *   { userId: 'abc' },
 *   where('status', '==', 'VERIFIED'),
 *   orderBy('urgencyScore', 'desc'),
 * );
 */
export function subscribeToDocuments<T extends DocumentData>(
  collectionName: string,
  callback: (data: T[]) => void,
  ctx: LogContext | undefined,
  ...constraints: QueryConstraint[]
): Unsubscribe {
  logger.debug('subscribeToDocuments', 'subscribing', { collection: collectionName }, ctx);

  const q = query(collection(db, collectionName), ...constraints);

  return onSnapshot(
    q,
    (snap) => {
      callback(queryToTyped<T>(snap));
    },
    (err) => {
      logger.error(
        'subscribeToDocuments',
        'snapshot error',
        normaliseFirestoreError(err),
        { collection: collectionName },
        ctx,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/** Re-export COLLECTIONS so callers only need to import from this module. */
export { COLLECTIONS };

/**
 * Re-export `serverTimestamp` so callers don't need an extra Firebase import
 * just to set a timestamp field.
 *
 * @example
 * await updateDocument(COLLECTIONS.NEEDS, id, { updatedAt: serverTimestamp() });
 */
export { serverTimestamp };
