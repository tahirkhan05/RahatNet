/**
 * @module assignment
 *
 * Types for volunteer task assignments.
 *
 * An Assignment is created when a coordinator (or the automated dispatch
 * algorithm) selects a volunteer for a CanonicalNeed.  It drives the
 * FCM push notification to the volunteer and tracks the full lifecycle
 * from notification → acceptance → completion.
 *
 * Firestore path: /assignments/{assignmentId}
 */

import type { Timestamp } from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a volunteer task assignment.
 *
 * State machine:
 *   CREATED → NOTIFIED → ACCEPTED → IN_PROGRESS → COMPLETED
 *                      ↘ DECLINED  (auto-reassign to next best volunteer)
 *                                ↘ FAILED     (volunteer reported unable to complete)
 */
export enum AssignmentStatus {
  /**
   * Assignment record written to Firestore; FCM notification not yet sent.
   * This state is transient — the Cloud Function moves to NOTIFIED within seconds.
   */
  CREATED = 'CREATED',
  /**
   * FCM push notification delivered to volunteer device.
   * The volunteer has 60 seconds to accept before auto-decline triggers.
   */
  NOTIFIED = 'NOTIFIED',
  /**
   * Volunteer tapped "Accept" in the task modal.
   * Location tracking starts; ETA is computed via Google Maps Routes API.
   */
  ACCEPTED = 'ACCEPTED',
  /**
   * Volunteer declined the task (tapped "Decline" or notification timed out).
   * Dispatcher retries with the next best volunteer match.
   */
  DECLINED = 'DECLINED',
  /**
   * Volunteer has arrived at the location and is actively helping.
   * Triggered when the volunteer taps "I've arrived" or is within 50 m of the need.
   */
  IN_PROGRESS = 'IN_PROGRESS',
  /**
   * Volunteer marked the task complete.
   * The associated CanonicalNeed status is updated to RESOLVED.
   */
  COMPLETED = 'COMPLETED',
  /**
   * Volunteer reported they were unable to complete the task
   * (e.g. access blocked, situation changed).  Coordinator is notified.
   * The associated need is re-queued as VERIFIED for reassignment.
   */
  FAILED = 'FAILED',
}

/**
 * Reason codes a volunteer can select when declining a task.
 * Stored in `declinedReason` for coordinator awareness and model improvement.
 */
export enum DeclineReason {
  /** Volunteer is too far away to arrive in time. */
  TOO_FAR = 'TOO_FAR',
  /** Volunteer does not have the required equipment. */
  NO_EQUIPMENT = 'NO_EQUIPMENT',
  /** Volunteer is already assisting with another emergency not in the system. */
  ALREADY_ENGAGED = 'ALREADY_ENGAGED',
  /** Volunteer is unwell or injured. */
  HEALTH_ISSUE = 'HEALTH_ISSUE',
  /** Road or access route is blocked. */
  ACCESS_BLOCKED = 'ACCESS_BLOCKED',
  /** Volunteer did not respond within the 60-second acceptance window. */
  TIMEOUT = 'TIMEOUT',
  /** Any other reason (requires free-text in `declinedNote`). */
  OTHER = 'OTHER',
}

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/**
 * Breakdown of the composite match score by contributing factor.
 * All values are in the range [0–100].  Stored for algorithm auditability.
 *
 * Final score formula:
 *   (distanceScore × 0.40) + (skillScore × 0.35) + (languageScore × 0.15) + (historyScore × 0.10)
 */
export interface MatchFactors {
  /**
   * Score based on driving distance from volunteer to need location.
   * Calculated via Google Maps Distance Matrix API.
   * Formula: max(0, 100 − drivingMinutes × 5)
   */
  readonly distanceScore: number;
  /**
   * Score based on skill alignment between the volunteer's registered skills
   * and the skills required by the need type.
   * Primary skill match → 100, secondary → 60, no match → 20.
   */
  readonly skillScore: number;
  /**
   * Score based on whether the volunteer speaks the reporter's language.
   * Exact match → 100, both speak English → 50, no common language → 0.
   */
  readonly languageScore: number;
  /**
   * Score based on the volunteer's historical performance.
   * Formula: (completionRate × 0.5 + rating/5 × 0.3 + responseScore × 0.2) × 100.
   * Null-safe: defaults to 50 for volunteers with no history.
   */
  readonly historyScore: number;
  /**
   * Estimated driving time in minutes to the need location.
   * Stored for display in the coordinator's assignment modal.
   */
  readonly estimatedDrivingMinutes: number;
}

/**
 * Performance metrics for a completed assignment.
 * Recorded when status transitions to COMPLETED.
 * Used to update VolunteerStats and feed the BigQuery analytics pipeline.
 */
export interface AssignmentMetrics {
  /**
   * Minutes from CREATED timestamp to volunteer arrival at location.
   * This is the "response time" KPI tracked against the 8-minute target.
   */
  readonly responseTimeMinutes: number;
  /**
   * Minutes from ACCEPTED to COMPLETED.
   * Measures how long the volunteer spent on-site.
   */
  readonly onSiteMinutes: number;
  /**
   * Rating given by the coordinator after task completion (1–5 stars).
   * Null if the coordinator did not rate the assignment.
   */
  readonly coordinatorRating: number | null;
  /** Free-text feedback from the coordinator. */
  readonly coordinatorNote: string | null;
}

/**
 * FCM push notification payload sent to the volunteer when a task is assigned.
 * Stored on the Assignment for audit and retry purposes.
 */
export interface AssignmentNotification {
  /** FCM registration token the notification was sent to. */
  readonly fcmToken: string;
  /** ISO timestamp when the notification was sent. */
  readonly sentAt: string;
  /**
   * Whether the FCM send succeeded.
   * False if the token was invalid or the device was unreachable.
   */
  readonly delivered: boolean;
  /**
   * FCM message ID returned on success.
   * Null on failure.
   */
  readonly messageId: string | null;
  /** Error message from FCM if delivery failed. Null on success. */
  readonly errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Core domain interfaces
// ---------------------------------------------------------------------------

/**
 * A task assignment linking a CanonicalNeed to a volunteer.
 *
 * Created by POST /api/dispatch (coordinator manual or auto-select).
 * The Cloud Function trigger `onNeedAssigned` reads this document and
 * sends the FCM notification to the volunteer.
 *
 * Firestore path: /assignments/{assignmentId}
 */
export interface Assignment {
  /** Firestore document ID. */
  readonly id: string;
  /** ID of the CanonicalNeed being addressed. */
  readonly needId: string;
  /** Firebase Auth UID of the assigned volunteer. */
  readonly volunteerId: string;
  /**
   * Firebase Auth UID of the coordinator who made the assignment,
   * or the string literal 'SYSTEM_AUTO' for automated dispatch.
   */
  readonly coordinatorId: string;
  /** Current lifecycle status of this assignment. */
  readonly status: AssignmentStatus;
  /**
   * Aggregate match score [0–100] from the dispatch algorithm.
   * Higher is better.  Used for coordinator UI display only — the algorithm
   * already selected the best available volunteer.
   */
  readonly matchScore: number;
  /** Breakdown of the match score by contributing factor. */
  readonly matchFactors: MatchFactors;
  /**
   * Message sent to the volunteer with the task push notification.
   * Pre-filled by the dispatcher: "Please proceed to {locationName}."
   * Coordinator can customise before confirming dispatch.
   */
  readonly message: string;
  /**
   * FCM notification delivery record.
   * Null until the Cloud Function attempts delivery.
   */
  readonly notification: AssignmentNotification | null;
  /** Firestore server timestamp when the Assignment was created. */
  readonly createdAt: Timestamp;
  /**
   * Firestore server timestamp when the volunteer accepted the task.
   * Null until the volunteer taps "Accept".
   */
  readonly acceptedAt: Timestamp | null;
  /**
   * Firestore server timestamp when the volunteer arrived on site.
   * Null until arrival is confirmed (auto or manual).
   */
  readonly arrivedAt: Timestamp | null;
  /**
   * Firestore server timestamp when the volunteer marked the task complete.
   * Null until COMPLETED.
   */
  readonly completedAt: Timestamp | null;
  /**
   * Structured reason code for why the volunteer declined.
   * Null unless status === DECLINED.
   */
  readonly declinedReason: DeclineReason | null;
  /**
   * Free-text note from the volunteer when declining with reason OTHER,
   * or when reporting a failure.
   * Null unless status is DECLINED or FAILED.
   */
  readonly declinedNote: string | null;
  /**
   * Performance metrics recorded at task completion.
   * Null until status === COMPLETED.
   */
  readonly metrics: AssignmentMetrics | null;
  /**
   * True when this document was inserted by the demo seed script.
   * Used by the clear-demo script to safely delete only demo data.
   */
  readonly isDemoData?: boolean;
}

/**
 * A status-change event appended to the assignment's audit log.
 *
 * Each status transition is recorded as a separate event to support
 * timeline views in the coordinator dashboard and incident post-mortems.
 *
 * Firestore path: /assignments/{assignmentId}/history/{eventId}
 */
export interface AssignmentUpdate {
  /** Firestore document ID of the update event. */
  readonly id: string;
  /** ID of the parent Assignment. */
  readonly assignmentId: string;
  /** Firebase Auth UID of the volunteer involved. */
  readonly volunteerId: string;
  /** Status before this transition. */
  readonly previousStatus: AssignmentStatus;
  /** Status after this transition. */
  readonly newStatus: AssignmentStatus;
  /**
   * Human-readable explanation for this transition.
   * Auto-generated for system transitions; user-provided for declines.
   */
  readonly reason?: string;
  /**
   * GPS coordinates of the volunteer at the time of the transition.
   * Used to reconstruct the volunteer's route on the coordinator timeline.
   * Null when location was unavailable (e.g. GPS denied).
   */
  readonly volunteerLocation: {
    readonly lat: number;
    readonly lng: number;
  } | null;
  /** Firestore server timestamp of this transition. */
  readonly updatedAt: Timestamp;
}
