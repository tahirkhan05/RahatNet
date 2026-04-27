/**
 * Disaster Activation — called by imdPoller for every new RED IMD alert.
 *
 * activateDisasterMode() is the single entry point.  It:
 *
 *   1. Checks whether a DisasterEvent already exists for the same districts
 *      today (idempotency guard — safe to call multiple times).
 *
 *   2. Creates a DisasterEvent document in Firestore with MONITORING status.
 *      Status transitions to ACTIVE when the first citizen need is submitted.
 *
 *   3. Creates an AlertTrigger audit record.
 *
 *   4. Publishes to RTDB /disasterAlerts so all connected clients (war room,
 *      volunteer apps) receive the alert within < 100 ms.
 *
 *   5. Sends FCM topic notifications to volunteers in affected districts.
 *      FCM topic: `district-{districtName}` (lowercase, spaces → hyphens).
 *      Volunteers subscribe to their district topic at onboarding time.
 *
 *   6. Sends a targeted notification to every COORDINATOR whose
 *      managedDistricts intersects with the affected districts.
 *      (Unlike volunteers we message them individually, not via topic, so we
 *      can record the notification in Firestore for audit.)
 *
 *   7. Logs the activation event to BigQuery for analytics.
 *
 * Rate limiting:
 *   FCM topic sends are fire-and-forget (one send per district topic).
 *   For coordinator individual FCM we send up to MAX_FCM_INDIVIDUAL at a time
 *   using sendEachForMulticast to stay well within FCM rate limits.
 */

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getMessaging } from 'firebase-admin/messaging';
import {
  DisasterType,
  DisasterSeverity,
  DisasterStatus,
  DisasterPhase,
  COLLECTIONS,
} from '@rahatnet/types';
import type {
  IMDAlert,
  DisasterEvent,
  BoundingBox,
  CoordinatorProfile,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function log(
  severity: 'INFO' | 'WARNING' | 'ERROR',
  operation: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const level = severity === 'INFO' ? 'info' : severity === 'WARNING' ? 'warn' : 'error';
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ severity, operation, message, ...extra }));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum individual coordinator FCM sends per activation (rate limit guard). */
const MAX_FCM_INDIVIDUAL = 500;

/** Maximum volunteer topic notifications per activation. */
const MAX_TOPIC_SENDS = 500;

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function colorToSeverity(colorCode: string): DisasterSeverity {
  return colorCode === 'RED' ? DisasterSeverity.CATASTROPHIC : DisasterSeverity.SEVERE;
}

// ---------------------------------------------------------------------------
// FCM topic name for a district
// ---------------------------------------------------------------------------

function districtTopic(district: string): string {
  return `district-${district.toLowerCase().replace(/\s+/g, '-')}`;
}

// ---------------------------------------------------------------------------
// BigQuery logging
// ---------------------------------------------------------------------------

async function logActivationToBigQuery(params: {
  disasterEventId:     string;
  alertId:             string;
  alertType:           string;
  colorCode:           string;
  districts:           string[];
  volunteersNotified:  number;
  coordinatorsNotified: number;
}): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';
  if (!projectId) return;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    await new BigQuery({ projectId })
      .dataset(datasetId)
      .table('disaster_activations')
      .insert([
        {
          disaster_event_id:     params.disasterEventId,
          alert_id:              params.alertId,
          alert_type:            params.alertType,
          color_code:            params.colorCode,
          districts:             params.districts.join(','),
          volunteers_notified:   params.volunteersNotified,
          coordinators_notified: params.coordinatorsNotified,
          activated_at:          new Date().toISOString(),
        },
      ]);
  } catch {
    // BigQuery logging is best-effort — never throw.
  }
}

// ---------------------------------------------------------------------------
// activateDisasterMode — main export
// ---------------------------------------------------------------------------

/**
 * Activate disaster mode for a new RED IMD alert.
 *
 * @param alert   The IMDAlert document just written to Firestore.
 * @param bbox    Pre-computed bounding box from the imdPoller geocoder.
 */
export async function activateDisasterMode(
  alert: IMDAlert,
  bbox:  BoundingBox,
): Promise<void> {
  const db        = getFirestore();
  const rtdb      = getDatabase();
  const messaging = getMessaging();

  log('INFO', 'activateDisasterMode', 'Starting activation', {
    alertId:   alert.id,
    districts: alert.districts,
    colorCode: alert.colorCode,
  });

  // ── Idempotency: check for existing event covering these districts today ──

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const existingSnap = await db
    .collection('disasterEvents')
    .where('activatedBy', '==', 'SYSTEM_AUTO')
    .where('activatedAt', '>=', Timestamp.fromDate(todayStart))
    .where('type', '==', alert.alertType)
    .limit(10)
    .get();

  for (const doc of existingSnap.docs) {
    const ev = doc.data() as { affectedDistricts: string[] };
    const overlap = (ev.affectedDistricts ?? []).some(
      (d) => alert.districts.includes(d),
    );
    if (overlap) {
      log('INFO', 'activateDisasterMode', 'Duplicate activation skipped', {
        existingEventId: doc.id,
        districts:       alert.districts,
      });
      return;
    }
  }

  // ── 1. Create DisasterEvent in Firestore ──────────────────────────────────

  const eventRef    = db.collection('disasterEvents').doc();
  const eventName   = `${alert.alertType} Alert — ${alert.districts.join(', ')}, ${alert.state}`;
  const severity    = colorToSeverity(alert.colorCode);

  const disasterEvent: Omit<DisasterEvent, 'id' | 'activatedAt' | 'updatedAt'> = {
    name:              eventName,
    type:              alert.alertType as DisasterType,
    severity,
    status:            DisasterStatus.MONITORING,
    phase:             DisasterPhase.RESPONSE,
    affectedDistricts: [...alert.districts],
    affectedStates:    [alert.state],
    boundingBox:       bbox,
    activatedBy:       'SYSTEM_AUTO',
    resolvedAt:        null,
    resolvedBy:        null,
    officialUrl:       null,
    stats: {
      totalNeeds:             0,
      resolvedNeeds:          0,
      inProgressNeeds:        0,
      pendingNeeds:           0,
      activeVolunteers:       0,
      avgResponseTimeMinutes: null,
      totalReports:           0,
      resolutionRate:         null,
    },
  };

  await eventRef.set({
    ...disasterEvent,
    activatedAt: FieldValue.serverTimestamp(),
  });

  log('INFO', 'activateDisasterMode', 'DisasterEvent created', {
    eventId: eventRef.id,
    name:    eventName,
  });

  // ── 2. Publish to RTDB /disasterAlerts ────────────────────────────────────

  const rtdbPayload = {
    name:      eventName,
    type:      alert.alertType,
    severity,
    districts: alert.districts,
    issuedAt:  Date.now(),
  };

  try {
    await rtdb.ref(`disasterAlerts/${eventRef.id}`).set(rtdbPayload);
    log('INFO', 'activateDisasterMode', 'RTDB alert published', { eventId: eventRef.id });
  } catch (err) {
    log('ERROR', 'activateDisasterMode', 'RTDB write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal — the DisasterEvent is created; the war-room will still load.
  }

  // ── 3. FCM topic notifications to volunteers ──────────────────────────────

  let volunteersNotified = 0;
  let topicSendCount     = 0;

  for (const district of alert.districts) {
    if (topicSendCount >= MAX_TOPIC_SENDS) {
      log('WARNING', 'activateDisasterMode', 'FCM topic send limit reached', {
        limit: MAX_TOPIC_SENDS,
      });
      break;
    }

    const topic = districtTopic(district);

    try {
      await messaging.send({
        topic,
        notification: {
          title: '🚨 Disaster Alert — Your area needs you',
          body:  `A ${alert.alertType.toLowerCase()} ${alert.colorCode.toLowerCase()} alert has been issued for ${district}. Please register your availability on RahatNet.`,
        },
        data: {
          type:            'DISASTER_ALERT',
          disasterEventId: eventRef.id,
          disasterName:    eventName,
          severity,
          districts:       alert.districts.join(','),
          clickUrl:        '/volunteer/tasks',
        },
        android: {
          priority: 'high',
          notification: { channelId: 'disaster-alerts' },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
          headers:  { 'apns-priority': '10' },
        },
      });

      // Note: we don't know the exact count of subscribers to a topic, so we
      // log 1 send per topic as a lower bound.
      volunteersNotified += 1;
      topicSendCount     += 1;

      log('INFO', 'activateDisasterMode', 'Topic notification sent', {
        topic, district,
      });
    } catch (err) {
      log('ERROR', 'activateDisasterMode', 'Topic FCM failed', {
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 4. Individual FCM to coordinators in affected districts ──────────────

  let coordinatorsNotified = 0;

  try {
    // Query coordinators whose managedDistricts overlaps with the affected list.
    // Firestore doesn't support array-contains-any on arrays of strings in a
    // single query when we have multiple values, so we query for one district
    // at a time (or use array-contains if there's only one district).
    const coordTokens: string[] = [];

    for (const district of alert.districts) {
      const snap = await db
        .collection(COLLECTIONS.USERS)
        .where('role', 'in', ['COORDINATOR', 'ADMIN'])
        .where('managedDistricts', 'array-contains', district)
        .limit(100)
        .get();

      for (const doc of snap.docs) {
        const profile = doc.data() as CoordinatorProfile & { fcmToken?: string | null };
        if (profile.fcmToken && !coordTokens.includes(profile.fcmToken)) {
          coordTokens.push(profile.fcmToken);
        }
      }
    }

    // Batch into groups of 500 (FCM multicast limit).
    const BATCH = 500;
    for (let i = 0; i < coordTokens.length && i < MAX_FCM_INDIVIDUAL; i += BATCH) {
      const batch   = coordTokens.slice(i, Math.min(i + BATCH, MAX_FCM_INDIVIDUAL));
      const result  = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title: `⚠️ Coordinator Alert — ${alert.alertType} ${alert.colorCode}`,
          body:  `${alert.headline}. Disaster event "${eventName}" has been created. Open the war room.`,
        },
        data: {
          type:            'COORDINATOR_ALERT',
          disasterEventId: eventRef.id,
          colorCode:       alert.colorCode,
          clickUrl:        `/coordinator/war-room?event=${eventRef.id}`,
        },
        android: { priority: 'high' },
        apns:    { payload: { aps: { sound: 'default' } } },
      });

      coordinatorsNotified += result.successCount;

      log('INFO', 'activateDisasterMode', 'Coordinator FCM batch sent', {
        batchSize: batch.length,
        success:   result.successCount,
        failure:   result.failureCount,
      });
    }
  } catch (err) {
    log('ERROR', 'activateDisasterMode', 'Coordinator FCM failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal.
  }

  // ── 5. Create AlertTrigger audit record ───────────────────────────────────

  try {
    await db.collection('alertTriggers').add({
      imdAlert:             alert,
      disasterEventId:      eventRef.id,
      triggeredAt:          FieldValue.serverTimestamp(),
      volunteersNotified,
      coordinatorsNotified,
      activationMode:       'AUTOMATIC',
      activationError:      null,
    });
  } catch (err) {
    log('ERROR', 'activateDisasterMode', 'AlertTrigger write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── 6. BigQuery analytics log ─────────────────────────────────────────────

  void logActivationToBigQuery({
    disasterEventId:      eventRef.id,
    alertId:              alert.id,
    alertType:            alert.alertType,
    colorCode:            alert.colorCode,
    districts:            [...alert.districts],
    volunteersNotified,
    coordinatorsNotified,
  });

  log('INFO', 'activateDisasterMode', 'Activation complete', {
    eventId:              eventRef.id,
    volunteersNotified,
    coordinatorsNotified,
  });
}
