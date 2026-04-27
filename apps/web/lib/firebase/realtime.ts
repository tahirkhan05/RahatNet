'use client';

/**
 * Firebase Realtime Database client library.
 *
 * The RTDB is used for low-latency data that changes frequently and must
 * propagate to all connected clients instantly (< 100 ms):
 *
 *   /liveNeedsFeed/{needId}       — minimal need projection for the war-room heatmap
 *   /volunteerLocations/{uid}     — live GPS positions of available volunteers
 *   /disasterAlerts/{alertId}     — disaster activation pushed to all clients
 *
 * Full document state lives in Firestore; the RTDB holds only the fields
 * needed for real-time rendering without a round-trip to Firestore on each
 * update.
 *
 * Error handling:
 *   `onValue` accepts an error callback — we log the error but do not throw,
 *   because the RTDB client reconnects automatically after transient failures.
 *
 * Typing:
 *   Feed items are typed against the interfaces in @rahatnet/types (api.ts).
 *   Callers receive fully typed objects — no `unknown` leaks into component code.
 */

import {
  getDatabase,
  ref,
  set,
  remove,
  onValue,
  off,
  serverTimestamp,
  type Database,
  type DatabaseReference,
  type Unsubscribe,
} from 'firebase/database';
import { firebaseApp } from './client';
import { AppError } from '@/lib/utils/errors';
import { createLogger } from './logger';
import type { LogContext } from './logger';
import type {
  CanonicalNeed,
  RealtimeNeedFeedItem,
  RealtimeVolunteerLocation,
  RealtimeDisasterAlert,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// RTDB singleton
// ---------------------------------------------------------------------------

export const rtdb: Database = getDatabase(firebaseApp);

const logger = createLogger('realtime');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an RTDB `set` call in error normalisation.
 * `set` rarely fails (it buffers locally and syncs when online), but we
 * surface a user-facing message on persistent failures.
 */
async function rtdbSet(
  dbRef: DatabaseReference,
  value: unknown,
  operation: string,
  ctx?: LogContext,
): Promise<void> {
  try {
    await set(dbRef, value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(operation, 'RTDB set failed', { name: 'RTDBError', message }, undefined, ctx);
    throw new AppError(
      'UPSTREAM_ERROR',
      'Could not sync data. Please check your connection.',
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Live needs feed
// ---------------------------------------------------------------------------

/**
 * Subscribe to the live needs feed in the war-room.
 *
 * The feed is a flat map of needId → `RealtimeNeedFeedItem`.  Each item
 * contains only the fields required to render the map pin and priority queue
 * row without querying Firestore.
 *
 * @param callback  - receives the current snapshot on every change
 * @param ctx       - optional logging context
 * @returns Unsubscribe — call on component unmount
 *
 * @example
 * const unsub = subscribeToNeedsFeed((needs) => setFeedNeeds(Object.values(needs)));
 */
export function subscribeToNeedsFeed(
  callback: (needs: Readonly<Record<string, RealtimeNeedFeedItem>>) => void,
  ctx?: LogContext,
): Unsubscribe {
  logger.debug('subscribeToNeedsFeed', 'subscribing', undefined, ctx);
  const feedRef = ref(rtdb, 'liveNeedsFeed');

  onValue(
    feedRef,
    (snap) => {
      callback((snap.val() as Record<string, RealtimeNeedFeedItem>) ?? {});
    },
    (err) => {
      logger.error(
        'subscribeToNeedsFeed',
        'onValue error',
        { name: err.name, message: err.message },
        undefined,
        ctx,
      );
    },
  );

  return () => {
    off(feedRef);
    logger.debug('subscribeToNeedsFeed', 'unsubscribed', undefined, ctx);
  };
}

/**
 * Push a canonical need update to the RTDB live feed.
 *
 * Called by the AI processing Cloud Function (server) and by the war-room
 * client when a coordinator changes a need's status.  Only the minimal
 * feed-item fields are written — the full document stays in Firestore.
 *
 * @param need  - the updated CanonicalNeed from Firestore
 * @param ctx   - optional logging context
 * @throws {AppError} on persistent write failure
 */
export async function publishNeedUpdate(need: CanonicalNeed, ctx?: LogContext): Promise<void> {
  logger.debug('publishNeedUpdate', 'publishing', { needId: need.id }, ctx);

  const feedItem: RealtimeNeedFeedItem = {
    title: need.title,
    type: need.type,
    severity: need.severity,
    urgencyScore: need.urgencyScore,
    status: need.status,
    lat: need.location.lat,
    lng: need.location.lng,
    updatedAt: Date.now(),
  };

  await rtdbSet(ref(rtdb, `liveNeedsFeed/${need.id}`), feedItem, 'publishNeedUpdate', ctx);
  logger.debug('publishNeedUpdate', 'published', { needId: need.id }, ctx);
}

/**
 * Remove a resolved or cancelled need from the live feed.
 * Cleans up the heatmap so the pin disappears immediately.
 *
 * @param needId  - Firestore document ID of the need
 * @param ctx     - optional logging context
 */
export async function removeNeedFromFeed(needId: string, ctx?: LogContext): Promise<void> {
  logger.debug('removeNeedFromFeed', 'removing', { needId }, ctx);
  try {
    await remove(ref(rtdb, `liveNeedsFeed/${needId}`));
    logger.debug('removeNeedFromFeed', 'removed', { needId }, ctx);
  } catch (err) {
    logger.warn(
      'removeNeedFromFeed',
      'failed to remove — need will expire naturally',
      { name: err instanceof Error ? err.name : 'Error', message: String(err) },
      { needId },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Volunteer locations
// ---------------------------------------------------------------------------

/**
 * Update a volunteer's live GPS location in the RTDB.
 *
 * Should be called every 30 seconds while the volunteer is available.
 * The war-room reads this to render volunteer positions on the map.
 *
 * The RTDB rules allow a volunteer to write only their own UID path:
 *   `volunteerLocations/$uid` is writable only when `auth.uid === $uid`.
 *
 * @param uid       - Firebase Auth UID of the volunteer
 * @param lat       - WGS-84 latitude
 * @param lng       - WGS-84 longitude
 * @param heading   - compass heading in degrees (0 = North), optional
 * @param speed     - speed in m/s, optional
 * @param ctx       - optional logging context
 */
export async function updateVolunteerLocation(
  uid: string,
  lat: number,
  lng: number,
  heading?: number,
  speed?: number,
  ctx?: LogContext,
): Promise<void> {
  logger.debug('updateVolunteerLocation', 'updating', { uid: uid.slice(0, 8) + '…' }, ctx);

  const payload: RealtimeVolunteerLocation = {
    lat,
    lng,
    heading: heading ?? 0,
    speed: speed ?? 0,
    isAvailable: true,
    updatedAt: Date.now(),
  };

  await rtdbSet(ref(rtdb, `volunteerLocations/${uid}`), payload, 'updateVolunteerLocation', ctx);
}

/**
 * Remove a volunteer's location from the RTDB.
 *
 * Call when the volunteer toggles to UNAVAILABLE or signs out.
 * Removes the map pin from the war-room without waiting for the 30-second
 * location update timeout.
 *
 * @param uid  - Firebase Auth UID of the volunteer
 * @param ctx  - optional logging context
 */
export async function removeVolunteerLocation(uid: string, ctx?: LogContext): Promise<void> {
  logger.debug('removeVolunteerLocation', 'removing', { uid: uid.slice(0, 8) + '…' }, ctx);
  try {
    await remove(ref(rtdb, `volunteerLocations/${uid}`));
    logger.debug('removeVolunteerLocation', 'removed', undefined, ctx);
  } catch (err) {
    logger.warn(
      'removeVolunteerLocation',
      'failed — location will expire on next read',
      { name: err instanceof Error ? err.name : 'Error', message: String(err) },
      undefined,
      ctx,
    );
  }
}

/**
 * Subscribe to all volunteer locations in the war-room.
 *
 * Returns a map of uid → `RealtimeVolunteerLocation`.  The war-room map
 * renders a marker for each entry where `isAvailable === true`.
 *
 * @param callback  - receives the full locations map on every change
 * @param ctx       - optional logging context
 * @returns Unsubscribe
 */
export function subscribeToVolunteerLocations(
  callback: (locations: Readonly<Record<string, RealtimeVolunteerLocation>>) => void,
  ctx?: LogContext,
): Unsubscribe {
  logger.debug('subscribeToVolunteerLocations', 'subscribing', undefined, ctx);
  const locRef = ref(rtdb, 'volunteerLocations');

  onValue(
    locRef,
    (snap) => {
      callback((snap.val() as Record<string, RealtimeVolunteerLocation>) ?? {});
    },
    (err) => {
      logger.error(
        'subscribeToVolunteerLocations',
        'onValue error',
        { name: err.name, message: err.message },
        undefined,
        ctx,
      );
    },
  );

  return () => {
    off(locRef);
    logger.debug('subscribeToVolunteerLocations', 'unsubscribed', undefined, ctx);
  };
}

// ---------------------------------------------------------------------------
// Disaster alerts
// ---------------------------------------------------------------------------

/**
 * Subscribe to disaster alerts pushed by the IMD polling Cloud Function.
 *
 * When a RED alert is detected the function writes to /disasterAlerts/{id}.
 * All connected clients receive it in < 100 ms and display the alert banner.
 *
 * @param callback  - receives a map of alertId → `RealtimeDisasterAlert`
 * @param ctx       - optional logging context
 * @returns Unsubscribe
 */
export function subscribeToDisasterAlerts(
  callback: (alerts: Readonly<Record<string, RealtimeDisasterAlert>>) => void,
  ctx?: LogContext,
): Unsubscribe {
  logger.debug('subscribeToDisasterAlerts', 'subscribing', undefined, ctx);
  const alertsRef = ref(rtdb, 'disasterAlerts');

  onValue(
    alertsRef,
    (snap) => {
      callback((snap.val() as Record<string, RealtimeDisasterAlert>) ?? {});
    },
    (err) => {
      logger.error(
        'subscribeToDisasterAlerts',
        'onValue error',
        { name: err.name, message: err.message },
        undefined,
        ctx,
      );
    },
  );

  return () => {
    off(alertsRef);
    logger.debug('subscribeToDisasterAlerts', 'unsubscribed', undefined, ctx);
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/** Re-export for callers that need the RTDB serverTimestamp. */
export { serverTimestamp as rtdbServerTimestamp };
