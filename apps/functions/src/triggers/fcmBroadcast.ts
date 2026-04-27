/**
 * FCM Broadcast utilities for RahatNet Cloud Functions.
 *
 * All five public functions are exported and used by other Cloud Functions.
 * They are NOT HTTP-triggered Cloud Functions themselves — they are helpers
 * imported by imdPoller, disasterActivation, and volunteerMatcher.
 *
 * Rate limiting:
 *   sendEachForMulticast is batched at 500 tokens per FCM call (FCM limit).
 *   broadcastToDistrict sends ONE topic message regardless of subscriber count
 *   — the rate limit here applies to the number of activations, not the number
 *   of devices (a single topic send can reach thousands of devices at no extra
 *   API cost vs. individual tokens).
 *   broadcastToVolunteersNearLocation is bounded by the Firestore query limit
 *   (maxResults) and the caller passes this from outside.
 *
 * Notification payloads always include a `clickUrl` in `data` so the
 * service-worker push handler can navigate to the right page without
 * needing to hard-code URLs in the SW.
 */

import { getFirestore }  from 'firebase-admin/firestore';
import { getMessaging }  from 'firebase-admin/messaging';
import {
  AssignmentStatus,
  NeedStatus,
  COLLECTIONS,
} from '@rahatnet/types';
import type {
  Assignment,
  CanonicalNeed,
  VolunteerProfile,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  fn: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const level = severity === 'INFO' ? 'info' : severity === 'WARNING' ? 'warn' : 'error';
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ severity, fn, message, ...extra }));
}

// ---------------------------------------------------------------------------
// Haversine (metres)
// ---------------------------------------------------------------------------

function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Notification payload types
// ---------------------------------------------------------------------------

export interface PushNotification {
  readonly title:    string;
  readonly body:     string;
  readonly data?:    Readonly<Record<string, string>>;
  readonly clickUrl?: string;
}

// ---------------------------------------------------------------------------
// FCM batch helper (500-token chunks)
// ---------------------------------------------------------------------------

interface BatchResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly invalidTokens: string[];
}

async function sendToTokens(
  tokens:       readonly string[],
  notification: PushNotification,
  maxTotal = 500,
): Promise<BatchResult> {
  const messaging     = getMessaging();
  const capped        = tokens.slice(0, maxTotal);
  let   successCount  = 0;
  let   failureCount  = 0;
  const invalidTokens: string[] = [];

  const CHUNK = 500;
  for (let i = 0; i < capped.length; i += CHUNK) {
    const batch = capped.slice(i, i + CHUNK) as string[];

    try {
      const res = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title: notification.title, body: notification.body },
        data: {
          ...(notification.data ?? {}),
          ...(notification.clickUrl != null ? { clickUrl: notification.clickUrl } : {}),
        },
        android: { priority: 'high', notification: { channelId: 'default' } },
        apns:    { payload: { aps: { sound: 'default' } } },
      });

      successCount += res.successCount;
      failureCount += res.failureCount;

      res.responses.forEach((r, idx) => {
        if (
          !r.success &&
          (r.error?.code === 'messaging/invalid-registration-token' ||
           r.error?.code === 'messaging/registration-token-not-registered')
        ) {
          invalidTokens.push(batch[idx] ?? '');
        }
      });
    } catch (err) {
      log('ERROR', 'sendToTokens', 'Batch send failed', {
        batchStart: i,
        error:      err instanceof Error ? err.message : String(err),
      });
      failureCount += batch.length;
    }
  }

  return { successCount, failureCount, invalidTokens };
}

// ---------------------------------------------------------------------------
// 1. subscribeVolunteerToDistrictTopic
// ---------------------------------------------------------------------------

/**
 * Subscribe a volunteer device to their district's FCM topic.
 *
 * Called from the onboarding Cloud Function (or the web API route) when
 * a volunteer registers.  The topic name format is `district-{name}` where
 * name is lowercase with spaces replaced by hyphens.
 *
 * @param fcmToken  The volunteer's FCM registration token.
 * @param district  The volunteer's home district name.
 */
export async function subscribeVolunteerToDistrictTopic(
  fcmToken: string,
  district: string,
): Promise<void> {
  const topic = `district-${district.toLowerCase().replace(/\s+/g, '-')}`;

  try {
    const messaging = getMessaging();
    await messaging.subscribeToTopic([fcmToken], topic);
    log('INFO', 'subscribeVolunteerToDistrictTopic', 'Subscribed', { topic, tokenPrefix: fcmToken.slice(0, 10) });
  } catch (err) {
    log('ERROR', 'subscribeVolunteerToDistrictTopic', 'Failed', {
      topic,
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal — volunteer may still receive individual notifications.
  }
}

// ---------------------------------------------------------------------------
// 2. broadcastToDistrict
// ---------------------------------------------------------------------------

/**
 * Send a push notification to all subscribers of a district FCM topic.
 *
 * One API call regardless of how many devices are subscribed to the topic.
 * This is the primary broadcast mechanism for disaster alerts — it scales
 * to millions of subscribers without additional API calls.
 *
 * @param district      Administrative district name.
 * @param notification  Notification content.
 */
export async function broadcastToDistrict(
  district:     string,
  notification: PushNotification,
): Promise<void> {
  const topic   = `district-${district.toLowerCase().replace(/\s+/g, '-')}`;
  const messaging = getMessaging();

  try {
    const messageId = await messaging.send({
      topic,
      notification: { title: notification.title, body: notification.body },
      data: {
        ...(notification.data ?? {}),
        ...(notification.clickUrl != null ? { clickUrl: notification.clickUrl } : {}),
      },
      android: { priority: 'high', notification: { channelId: 'disaster-alerts' } },
      apns:    { payload: { aps: { sound: 'default' } }, headers: { 'apns-priority': '10' } },
    });

    log('INFO', 'broadcastToDistrict', 'Topic message sent', { topic, messageId });
  } catch (err) {
    log('ERROR', 'broadcastToDistrict', 'Failed', {
      topic,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err; // Re-throw so the caller can handle it.
  }
}

// ---------------------------------------------------------------------------
// 3. broadcastToVolunteersNearLocation
// ---------------------------------------------------------------------------

/**
 * Send a push notification to all available volunteers within `radiusM`
 * metres of the given GPS coordinates.
 *
 * Uses live volunteer locations from RTDB /volunteerLocations (written by
 * the volunteer app every 30 s) to find nearby volunteers, then fetches
 * their FCM tokens from Firestore.
 *
 * @param lat           Target latitude.
 * @param lng           Target longitude.
 * @param radiusM       Search radius in metres.
 * @param notification  Notification content.
 * @param maxResults    Maximum volunteers to notify (default 500).
 * @returns             Number of notifications sent successfully.
 */
export async function broadcastToVolunteersNearLocation(
  lat:          number,
  lng:          number,
  radiusM:      number,
  notification: PushNotification,
  maxResults = 500,
): Promise<number> {
  // Read volunteer locations from RTDB.
  let locations: Record<string, { lat: number; lng: number; isAvailable: boolean }> = {};

  try {
    const { getDatabase } = await import('firebase-admin/database');
    const snap = await getDatabase().ref('volunteerLocations').get();
    locations  = (snap.val() as typeof locations) ?? {};
  } catch (err) {
    log('ERROR', 'broadcastToVolunteersNearLocation', 'RTDB read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  // Filter by radius and availability.
  const nearbyUids = Object.entries(locations)
    .filter(([, loc]) => loc.isAvailable && haversineM(lat, lng, loc.lat, loc.lng) <= radiusM)
    .slice(0, maxResults)
    .map(([uid]) => uid);

  if (nearbyUids.length === 0) {
    log('INFO', 'broadcastToVolunteersNearLocation', 'No nearby volunteers', { lat, lng, radiusM });
    return 0;
  }

  // Fetch FCM tokens from Firestore.
  const db     = getFirestore();
  const tokens: string[] = [];
  const CHUNK  = 30; // Firestore `in` limit

  for (let i = 0; i < nearbyUids.length; i += CHUNK) {
    try {
      const snap = await db
        .collection(COLLECTIONS.USERS)
        .where('__name__', 'in', nearbyUids.slice(i, i + CHUNK))
        .get();

      for (const doc of snap.docs) {
        const profile = doc.data() as VolunteerProfile & { fcmToken?: string | null };
        if (profile.fcmToken) tokens.push(profile.fcmToken);
      }
    } catch (err) {
      log('ERROR', 'broadcastToVolunteersNearLocation', 'Profile fetch failed', {
        chunkStart: i,
        error:      err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = await sendToTokens(tokens, notification, maxResults);

  log('INFO', 'broadcastToVolunteersNearLocation', 'Broadcast complete', {
    nearbyVolunteers: nearbyUids.length,
    tokensFound:      tokens.length,
    success:          result.successCount,
    failure:          result.failureCount,
  });

  return result.successCount;
}

// ---------------------------------------------------------------------------
// 4. sendTaskNotification
// ---------------------------------------------------------------------------

/**
 * Send a high-priority FCM push to a volunteer when a task is assigned.
 *
 * The notification includes deep-link data so the volunteer app can open the
 * task accept/decline modal directly without navigating manually.
 *
 * @param volunteerFcmToken  FCM registration token of the assigned volunteer.
 * @param assignment         The Assignment Firestore document.
 * @param need               The associated CanonicalNeed (for display text).
 */
export async function sendTaskNotification(
  volunteerFcmToken: string,
  assignment:        Assignment,
  need:              CanonicalNeed,
): Promise<boolean> {
  const messaging = getMessaging();

  try {
    await messaging.send({
      token: volunteerFcmToken,
      notification: {
        title: `New task: ${need.type}`,
        body:  `${need.locationName} — ${need.affectedCount} people affected`,
      },
      data: {
        type:         'TASK_ASSIGNED',
        assignmentId: assignment.id,
        needId:       need.id,
        needType:     need.type,
        locationName: need.locationName,
        message:      assignment.message,
        clickUrl:     `/volunteer/tasks?assignment=${assignment.id}`,
      },
      android: {
        priority: 'high',
        notification: {
          channelId:    'tasks',
          priority:     'max',
          defaultSound: true,
          vibrationTimingsMillis: [200, 100, 100],
        },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        headers:  { 'apns-priority': '10' },
      },
    });

    log('INFO', 'sendTaskNotification', 'Task FCM sent', {
      assignmentId: assignment.id,
      tokenPrefix:  volunteerFcmToken.slice(0, 10),
    });

    // Update assignment status to NOTIFIED in Firestore.
    const db = getFirestore();
    await db
      .collection(COLLECTIONS.ASSIGNMENTS)
      .doc(assignment.id)
      .update({ status: AssignmentStatus.NOTIFIED });

    return true;
  } catch (err) {
    log('ERROR', 'sendTaskNotification', 'Task FCM failed', {
      assignmentId: assignment.id,
      error:        err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5. sendStatusUpdateToReporter
// ---------------------------------------------------------------------------

/**
 * Send a push notification to the citizen who submitted a report, updating
 * them on the status of their reported need.
 *
 * This is a best-effort notification — if the citizen dismissed notification
 * permissions or uninstalled the app, the send fails silently.
 *
 * @param reporterFcmToken  FCM token of the original reporter.
 * @param need              The updated CanonicalNeed.
 */
export async function sendStatusUpdateToReporter(
  reporterFcmToken: string,
  need:             CanonicalNeed,
): Promise<void> {
  // Build a human-friendly status message.
  const statusMessages: Partial<Record<string, string>> = {
    [NeedStatus.VERIFIED]:    'Your report has been verified and is in the queue.',
    [NeedStatus.ASSIGNED]:    'Help is on the way! A volunteer has been dispatched.',
    [NeedStatus.IN_PROGRESS]: 'A volunteer has arrived and is helping now.',
    [NeedStatus.RESOLVED]:    'Your need has been resolved. Thank you for reporting.',
  };

  const body = statusMessages[need.status] ?? `Your report status changed to ${need.status}.`;

  try {
    const messaging = getMessaging();
    await messaging.send({
      token: reporterFcmToken,
      notification: {
        title: 'RahatNet — Report Update',
        body,
      },
      data: {
        type:     'REPORT_UPDATE',
        needId:   need.id,
        status:   need.status,
        clickUrl: `/citizen/status?report=${need.id}`,
      },
      android: {
        notification: { channelId: 'updates' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    });

    log('INFO', 'sendStatusUpdateToReporter', 'Status update sent', {
      needId:      need.id,
      status:      need.status,
      tokenPrefix: reporterFcmToken.slice(0, 10),
    });
  } catch (err) {
    log('WARNING', 'sendStatusUpdateToReporter', 'Send failed (non-fatal)', {
      needId: need.id,
      error:  err instanceof Error ? err.message : String(err),
    });
    // Silently ignored — citizen notification is informational, not critical.
  }
}
