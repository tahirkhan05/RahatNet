/**
 * RahatNet Cloud Functions — entry point.
 * All exported symbols here are deployed as individual Cloud Functions.
 */

// AI pipeline
export { processReports } from './ai/processReports';

// Scheduled triggers
export { pollIMDAlerts } from './triggers/imdPoller';

// Firestore-triggered dispatch
export { onNeedAssigned } from './dispatch/volunteerMatcher';

// BigQuery analytics sync
export {
  onNeedResolved,
  onAssignmentCompleted,
  onDisasterActivated,
} from './analytics/bigquerySync';
