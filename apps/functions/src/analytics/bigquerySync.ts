/**
 * BigQuery Sync — Cloud Function triggered by Firestore writes.
 *
 * Keeps the BigQuery analytics tables in sync with real-time Firestore events
 * without requiring the web API routes to make synchronous BQ calls.
 *
 * Triggers:
 *   onNeedResolved    — fires when a need's status → RESOLVED
 *   onAssignmentCompleted — fires when an assignment status → COMPLETED
 *   onDisasterActivated   — fires when a DisasterEvent is created
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { COLLECTIONS } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function log(severity: 'INFO' | 'ERROR', fn: string, msg: string, extra?: Record<string, unknown>) {
  const level = severity === 'INFO' ? 'info' : 'error';
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ severity, fn, message: msg, ...extra }));
}

// ---------------------------------------------------------------------------
// BigQuery writer helper
// ---------------------------------------------------------------------------

async function insertRows(
  tableId: string,
  rows:    Record<string, unknown>[],
): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT_ID'];
  const datasetId = process.env['BIGQUERY_DATASET_ID'] ?? 'rahatnet_analytics';
  if (!projectId) return;

  try {
    const { BigQuery } = await import('@google-cloud/bigquery');
    await new BigQuery({ projectId }).dataset(datasetId).table(tableId).insert(rows);
  } catch (err) {
    log('ERROR', 'insertRows', `BigQuery insert failed for ${tableId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Trigger 1: Need written — log when status changes to RESOLVED
// ---------------------------------------------------------------------------

export const onNeedResolved = onDocumentWritten(
  {
    document: `${COLLECTIONS.NEEDS}/{needId}`,
    region:   'us-central1',
  },
  async (event) => {
    const before = event.data?.before?.data() as { status?: string } | undefined;
    const after  = event.data?.after?.data()  as {
      status?:        string;
      type?:          string;
      severity?:      string;
      urgencyScore?:  number;
      disasterEventId?: string;
      locationName?:  string;
      affectedCount?: number;
      createdAt?:     { seconds: number };
      resolvedAt?:    { seconds: number };
    } | undefined;

    if (!after || after.status !== 'RESOLVED') return;
    if (before?.status === 'RESOLVED') return; // already synced

    const needId = event.params['needId'];
    const createdSec  = after.createdAt?.seconds ?? 0;
    const resolvedSec = after.resolvedAt?.seconds ?? Math.floor(Date.now() / 1000);
    const responseMin = createdSec > 0 ? Math.round((resolvedSec - createdSec) / 60) : null;

    log('INFO', 'onNeedResolved', 'Syncing resolved need to BigQuery', { needId });

    await insertRows('need_events', [
      {
        need_id:          needId,
        disaster_id:      after.disasterEventId ?? '',
        need_type:        after.type            ?? '',
        severity:         after.severity        ?? '',
        urgency_score:    after.urgencyScore     ?? 0,
        location_name:    after.locationName     ?? '',
        affected_count:   after.affectedCount    ?? 0,
        created_at:       createdSec  > 0 ? new Date(createdSec  * 1000).toISOString() : null,
        resolved_at:      resolvedSec > 0 ? new Date(resolvedSec * 1000).toISOString() : null,
        response_minutes: responseMin,
      },
    ]);
  },
);

// ---------------------------------------------------------------------------
// Trigger 2: Assignment completed — log response time metrics
// ---------------------------------------------------------------------------

export const onAssignmentCompleted = onDocumentWritten(
  {
    document: `${COLLECTIONS.ASSIGNMENTS}/{assignmentId}`,
    region:   'us-central1',
  },
  async (event) => {
    const before = event.data?.before?.data() as { status?: string } | undefined;
    const after  = event.data?.after?.data()  as {
      status?:        string;
      needId?:        string;
      volunteerId?:   string;
      createdAt?:     { seconds: number };
      completedAt?:   { seconds: number };
      arrivedAt?:     { seconds: number };
      metrics?:       { responseTimeMinutes?: number; onSiteMinutes?: number };
    } | undefined;

    if (!after || after.status !== 'COMPLETED') return;
    if (before?.status === 'COMPLETED') return;

    const assignmentId = event.params['assignmentId'];
    log('INFO', 'onAssignmentCompleted', 'Syncing completed assignment to BigQuery', { assignmentId });

    const createdSec   = after.createdAt?.seconds   ?? 0;
    const completedSec = after.completedAt?.seconds ?? Math.floor(Date.now() / 1000);
    const responseMin  = after.metrics?.responseTimeMinutes
      ?? (createdSec > 0 ? Math.round((completedSec - createdSec) / 60) : 0);

    await insertRows('response_metrics', [
      {
        assignment_id:         assignmentId,
        need_id:               after.needId       ?? '',
        volunteer_id:          after.volunteerId  ?? '',
        response_time_minutes: responseMin,
        on_site_minutes:       after.metrics?.onSiteMinutes ?? 0,
        completed_at:          completedSec > 0
          ? new Date(completedSec * 1000).toISOString()
          : new Date().toISOString(),
      },
    ]);
  },
);

// ---------------------------------------------------------------------------
// Trigger 3: DisasterEvent created — log activation
// ---------------------------------------------------------------------------

export const onDisasterActivated = onDocumentWritten(
  {
    document: 'disasterEvents/{eventId}',
    region:   'us-central1',
  },
  async (event) => {
    // Only fire on CREATE (before doesn't exist).
    if (event.data?.before?.exists) return;

    const after = event.data?.after?.data() as {
      name?:              string;
      type?:              string;
      severity?:          string;
      affectedDistricts?: string[];
      activatedBy?:       string;
      activatedAt?:       { seconds: number };
    } | undefined;

    if (!after) return;

    const eventId = event.params['eventId'];
    log('INFO', 'onDisasterActivated', 'Logging disaster activation to BigQuery', { eventId });

    await insertRows('disaster_activations', [
      {
        event_id:           eventId,
        name:               after.name               ?? '',
        type:               after.type               ?? '',
        severity:           after.severity           ?? '',
        districts:          (after.affectedDistricts ?? []).join(','),
        activated_by:       after.activatedBy        ?? '',
        activated_at:       after.activatedAt
          ? new Date(after.activatedAt.seconds * 1000).toISOString()
          : new Date().toISOString(),
      },
    ]);
  },
);
