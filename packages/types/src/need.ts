/**
 * @module need
 *
 * Types for disaster needs and reports — the core data model of RahatNet.
 *
 * Data flow:
 *   Citizen submits → RawReport (status: PENDING)
 *        ↓  AI pipeline (Gemini de-duplication + Vertex urgency scoring)
 *   CanonicalNeed (status: VERIFIED)
 *        ↓  Coordinator assigns via dispatch algorithm
 *   CanonicalNeed (status: ASSIGNED) + Assignment record
 *        ↓  Volunteer completes
 *   CanonicalNeed (status: RESOLVED)
 */

import type { Timestamp } from 'firebase/firestore';
import type { AssignmentStatus } from './assignment';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Category of disaster need.
 * Drives icon selection, volunteer skill matching, and resource routing.
 */
export enum NeedType {
  /** Person trapped, stranded, or in immediate physical danger. */
  RESCUE = 'RESCUE',
  /** Food, drinking water, or baby formula required. */
  FOOD = 'FOOD',
  /** Prescription medicine, first aid, or medical attention required. */
  MEDICINE = 'MEDICINE',
  /** Temporary shelter, tarpaulins, or blankets required. */
  SHELTER = 'SHELTER',
  /** Psychological support, counselling, or grief assistance. */
  MENTAL_HEALTH = 'MENTAL_HEALTH',
  /** Road clearance, power line repair, or bridge assessment. */
  INFRASTRUCTURE = 'INFRASTRUCTURE',
}

/**
 * Lifecycle status of a need, from initial citizen submission to final resolution.
 * Transitions are always monotonically forward — a need never moves backwards
 * except from ASSIGNED back to VERIFIED (if a volunteer declines and no other
 * volunteer is available immediately).
 */
export enum NeedStatus {
  /** Submitted by citizen; not yet picked up by the AI pipeline. */
  PENDING = 'PENDING',
  /** Currently being processed by the Gemini de-duplication Cloud Function. */
  AI_PROCESSING = 'AI_PROCESSING',
  /** AI processed; urgency scored; visible in war-room queue. */
  VERIFIED = 'VERIFIED',
  /** A volunteer has been assigned and notified. */
  ASSIGNED = 'ASSIGNED',
  /** Volunteer accepted and is en-route or on-site. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Volunteer marked the task complete; need is addressed. */
  RESOLVED = 'RESOLVED',
  /** AI determined this is a duplicate of another canonical need. */
  DUPLICATE = 'DUPLICATE',
  /** Cancelled by a coordinator (e.g. false report, no longer relevant). */
  CANCELLED = 'CANCELLED',
}

/**
 * Urgency severity bucket derived from the numeric urgency score.
 *
 * Score mapping:
 *   8–10 → CRITICAL  (immediate threat to life)
 *   5–7  → URGENT    (serious, needs response within 1 hour)
 *   3–4  → NORMAL    (needs response within 4 hours)
 *   1–2  → LOW       (non-urgent; can wait for next cycle)
 */
export enum NeedSeverity {
  /** Score 8–10. Immediate threat to life — highest dispatch priority. */
  CRITICAL = 'CRITICAL',
  /** Score 5–7. Serious situation requiring response within 60 minutes. */
  URGENT = 'URGENT',
  /** Score 3–4. Significant but not immediately life-threatening. */
  NORMAL = 'NORMAL',
  /** Score 1–2. Inconvenience or minor issue; dispatched after critical/urgent. */
  LOW = 'LOW',
}

/**
 * Processing status of a raw citizen report.
 * Narrower than NeedStatus — only the states relevant before AI processing.
 */
export type RawReportStatus = 'PENDING' | 'PROCESSED' | 'DUPLICATE';

/**
 * Origin of a report or need.
 * CITIZEN — submitted via the real-time need reporting form during a disaster.
 * SURVEY  — submitted via the NGO community survey form (pre-disaster vulnerability data).
 */
export type ReportSource = 'CITIZEN' | 'SURVEY';

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/**
 * Urgency score as a branded number in the range [1, 10].
 * The brand prevents accidentally passing an unvalidated `number` where a
 * validated score is expected.
 *
 * @example
 * function scoreToSeverity(score: UrgencyScore): NeedSeverity { ... }
 * // scoreToSeverity(7)   ← TS error: 7 is not UrgencyScore
 * // scoreToSeverity(7 as UrgencyScore)  ← explicit cast in scoring module only
 */
export type UrgencyScore = number & { readonly __brand: 'UrgencyScore' };

/**
 * Cast a validated number to UrgencyScore.
 * Only call this inside the urgency scoring module after range validation.
 *
 * @throws {RangeError} when the value is outside [1, 10]
 */
export function toUrgencyScore(value: number): UrgencyScore {
  if (value < 1 || value > 10) {
    throw new RangeError(`UrgencyScore must be between 1 and 10, got ${value}`);
  }
  return value as UrgencyScore;
}

// ---------------------------------------------------------------------------
// Shared sub-types
// ---------------------------------------------------------------------------

/**
 * WGS-84 geographic coordinate pair.
 * Used for incident locations, volunteer positions, and resource tracking.
 */
export interface GeoPoint {
  /** Latitude in decimal degrees (−90 to 90). */
  readonly lat: number;
  /** Longitude in decimal degrees (−180 to 180). */
  readonly lng: number;
}

/**
 * Metadata written by the AI pipeline when processing a cluster of raw reports.
 * Stored on CanonicalNeed for auditability and model improvement.
 */
export interface AiProcessingMeta {
  /**
   * Gemini's confidence that all source reports describe the same incident.
   * Range: 0 (no confidence) to 1 (certain).
   */
  readonly deduplicationConfidence: number;
  /**
   * Breakdown of the final urgency score by signal.
   * Keys: 'keyword', 'photo', 'context', 'reportCount'.
   * Values: the raw score contribution from each signal (0–10).
   */
  readonly urgencyFactors: Readonly<Record<string, number>>;
  /**
   * Wall-clock milliseconds spent by the AI pipeline on this need.
   * Used to monitor processing latency and catch regressions.
   */
  readonly processingTimeMs: number;
  /** Gemini model ID used for de-duplication (e.g. 'gemini-1.5-flash'). */
  readonly modelId: string;
  /** ISO timestamp when the AI pipeline ran. */
  readonly processedAt: string;
}

// ---------------------------------------------------------------------------
// Core domain interfaces
// ---------------------------------------------------------------------------

/**
 * Raw, unprocessed report submitted by a citizen.
 *
 * Created immediately when a citizen submits a need.  Held in a PENDING state
 * until the AI batch-processing Cloud Function picks it up (typically within
 * 30 seconds).  After processing it is merged into a CanonicalNeed and its
 * status updated to PROCESSED or DUPLICATE.
 *
 * Firestore path: /rawReports/{reportId}
 */
export interface RawReport {
  /** Firestore document ID — also used as the idempotency key for offline sync. */
  readonly id: string;
  /** Firebase Auth UID of the reporting citizen. */
  readonly reporterId: string;
  /** Need category chosen by the citizen in step 1 of the report form. */
  readonly type: NeedType;
  /**
   * Description translated to English by the AI translation pipeline.
   * This is the text used for de-duplication and urgency scoring.
   */
  readonly description: string;
  /**
   * Description exactly as entered (or transcribed from voice) by the citizen.
   * Preserved verbatim for audit purposes and display in the coordinator UI.
   */
  readonly originalDescription: string;
  /**
   * BCP-47 language tag of the original description.
   * Populated by Google Translate language detection.
   * e.g. 'ml' for Malayalam, 'hi' for Hindi.
   */
  readonly originalLanguage: string;
  /**
   * Firebase Storage download URL of the recorded voice note.
   * Null when the citizen submitted text only.
   */
  readonly voiceNoteUrl: string | null;
  /**
   * Firebase Storage download URLs of photos attached to the report.
   * Maximum 5 photos per report; each compressed to ≤ 800px and ≤ 10 MB
   * client-side before upload.
   */
  readonly photoUrls: readonly string[];
  /** GPS coordinates captured at the time of submission. */
  readonly location: GeoPoint;
  /** Human-readable location name reverse-geocoded from `location`. */
  readonly locationName: string;
  /** Citizen's estimate of how many people are affected. Min 1, max 1000. */
  readonly affectedCount: number;
  /**
   * Whether the affected group includes a vulnerable individual:
   * elderly (60+), child (under 12), disabled, pregnant, or critically ill.
   * Adds +1.5 to the urgency score.
   */
  readonly hasVulnerable: boolean;
  /** Current stage in the AI processing pipeline. */
  readonly status: RawReportStatus;
  /**
   * Origin of this report.
   * Defaults to CITIZEN for real-time panic reports.
   * Set to SURVEY when an NGO field worker uses the community survey form.
   */
  readonly source: ReportSource;
  /**
   * ID of the CanonicalNeed this report was merged into.
   * Populated after the AI pipeline runs.  Null while still PENDING.
   */
  readonly canonicalNeedId: string | null;
  /** Firestore server timestamp of when the report was created. */
  readonly createdAt: Timestamp;
  /**
   * True when this document was inserted by the demo seed script.
   * Used by the clear-demo script to safely delete only demo data.
   */
  readonly isDemoData?: boolean;
}

/**
 * AI-deduplicated, urgency-scored canonical need card.
 *
 * One CanonicalNeed may represent dozens of raw reports from different
 * citizens about the same incident.  It is the unit of work for the war room:
 * coordinators see it in the priority queue, assign it to volunteers, and
 * mark it resolved.
 *
 * Firestore path: /needs/{needId}
 */
export interface CanonicalNeed {
  /** Firestore document ID. */
  readonly id: string;
  /**
   * Short, human-readable title synthesised by Gemini.
   * Format: "{NeedType} needed at {locationName} — {affectedCount} people"
   * e.g. "Rescue needed at Aluva Bridge — 7 people"
   */
  readonly title: string;
  /** Full description synthesised by Gemini from all source reports. */
  readonly description: string;
  /** Need category (drives icon, skill matching, resource routing). */
  readonly type: NeedType;
  /** Current lifecycle stage. */
  readonly status: NeedStatus;
  /** Urgency severity bucket derived from `urgencyScore`. */
  readonly severity: NeedSeverity;
  /**
   * Composite urgency score [1–10] computed by the AI pipeline.
   * Used to sort the war-room priority queue.
   * Formula: (keywordScore × 0.35) + (photoScore × 0.30) + (contextScore × 0.35)
   */
  readonly urgencyScore: UrgencyScore;
  /** Centroid GPS coordinates of the incident (from the source reports). */
  readonly location: GeoPoint;
  /** Reverse-geocoded human-readable location. */
  readonly locationName: string;
  /**
   * Total number of people affected, aggregated across all source reports.
   * The AI takes the maximum count when reports disagree.
   */
  readonly affectedCount: number;
  /**
   * True if any source report flagged a vulnerable individual.
   * Once set to true it cannot be set back to false — any report raising
   * the flag is treated as ground truth.
   */
  readonly hasVulnerable: boolean;
  /** IDs of the raw reports that were de-duplicated into this need. */
  readonly sourceReportIds: readonly string[];
  /**
   * Number of distinct citizens who independently reported the same incident.
   * Higher values increase the urgency score via the context signal.
   */
  readonly reportCount: number;
  /**
   * Firebase Auth UID of the volunteer currently assigned to this need.
   * Null when the need is unassigned (status: VERIFIED).
   */
  readonly assignedVolunteerId: string | null;
  /** Server timestamp when a volunteer was assigned. Null if unassigned. */
  readonly assignedAt: Timestamp | null;
  /** Server timestamp when the need was marked RESOLVED. Null if not yet resolved. */
  readonly resolvedAt: Timestamp | null;
  /**
   * ID of the DisasterEvent this need belongs to.
   * All needs are scoped to a disaster event for filtering and analytics.
   */
  readonly disasterEventId: string;
  /**
   * Origin of the source reports aggregated into this need.
   * SURVEY needs appear as pre-mapped vulnerability pins on the war room map,
   * distinct from real-time CITIZEN crisis pins.
   */
  readonly source: ReportSource;
  /** Server timestamp of first creation. */
  readonly createdAt: Timestamp;
  /** Server timestamp of last update to any field. */
  readonly updatedAt: Timestamp;
  /** AI pipeline audit trail. Stored for model improvement and debugging. */
  readonly aiProcessingMeta: AiProcessingMeta;
  /**
   * True when this document was inserted by the demo seed script.
   * Used by the clear-demo script to safely delete only demo data.
   */
  readonly isDemoData?: boolean;
}

/**
 * A cluster of raw reports identified by GPS proximity (within 200 m) and
 * confirmed by Gemini NLP as describing the same incident.
 *
 * NeedCluster is an ephemeral intermediate state used only inside the
 * AI processing Cloud Function — it is not persisted to Firestore.
 */
export interface NeedCluster {
  /** Raw reports grouped into this cluster. Min 1. */
  readonly reports: readonly RawReport[];
  /**
   * Arithmetic mean latitude of all report locations in the cluster.
   * Used as the canonical location when reports have slightly different coords.
   */
  readonly centroidLat: number;
  /**
   * Arithmetic mean longitude of all report locations in the cluster.
   */
  readonly centroidLng: number;
  /**
   * Gemini's confidence that all reports in the cluster describe exactly the
   * same physical incident.
   * Range: 0 (likely different incidents) to 1 (definitely same incident).
   * Clusters with confidence < 0.6 are split into sub-clusters for manual review.
   */
  readonly deduplicationConfidence: number;
  /**
   * When Gemini determines reports describe different incidents, the cluster
   * is split into sub-clusters.  This field holds those sub-groups by index
   * into `reports`.  Undefined when the cluster is not split.
   */
  readonly subClusters?: ReadonlyArray<readonly number[]>;
}

/**
 * Links a CanonicalNeed to a Volunteer for a specific task assignment.
 * This is the war-room's record of "who is going where".
 *
 * Note: the authoritative Assignment record lives in /assignments/{id}.
 * NeedAssignment is a denormalised copy embedded in need documents for
 * fast read access in the war-room queue without a secondary Firestore query.
 */
export interface NeedAssignment {
  /** Matches the Assignment document ID in /assignments/. */
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
  /** Current state of the assignment. */
  readonly status: AssignmentStatus;
  /**
   * Aggregate match score [0–100] produced by the dispatch algorithm.
   * Computed as a weighted sum of distanceScore, skillScore,
   * languageScore, and historyScore.
   */
  readonly matchScore: number;
  /**
   * Breakdown of the match score by contributing factor.
   * All values are in the range [0–100].
   */
  readonly matchFactors: {
    /** Score from volunteer proximity (40% weight). */
    readonly distanceScore: number;
    /** Score from skill alignment with need type (35% weight). */
    readonly skillScore: number;
    /** Score from shared language with the reporter (15% weight). */
    readonly languageScore: number;
    /** Score from historical task completion rate and rating (10% weight). */
    readonly historyScore: number;
  };
  /** Human-readable message sent to the volunteer with the task notification. */
  readonly message: string;
  /** Server timestamp when the assignment was created. */
  readonly createdAt: Timestamp;
  /** Server timestamp when the volunteer accepted. Null until accepted. */
  readonly acceptedAt: Timestamp | null;
  /** Server timestamp when the volunteer marked the task complete. */
  readonly completedAt: Timestamp | null;
  /** Free-text reason provided when a volunteer declines. Null if not declined. */
  readonly declinedReason: string | null;
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/**
 * Partial update payload for CanonicalNeed.
 * Only mutable fields are included — id, createdAt, sourceReportIds, etc.
 * cannot be updated after creation.
 */
export type NeedUpdatePayload = Partial<
  Pick<
    CanonicalNeed,
    | 'status'
    | 'severity'
    | 'urgencyScore'
    | 'affectedCount'
    | 'hasVulnerable'
    | 'assignedVolunteerId'
    | 'assignedAt'
    | 'resolvedAt'
    | 'description'
    | 'title'
  >
>;

/**
 * Query filter parameters accepted by GET /api/needs.
 * All fields are optional — omitted fields are not filtered on.
 */
export interface NeedFilters {
  /** Filter by one or more need types. */
  readonly types?: readonly NeedType[];
  /** Filter by one or more statuses. */
  readonly statuses?: readonly NeedStatus[];
  /** Only return needs at or above this severity. */
  readonly minSeverity?: NeedSeverity;
  /** Only return needs belonging to this disaster event. */
  readonly disasterEventId?: string;
  /** Only return needs assigned to this volunteer UID. */
  readonly assignedVolunteerId?: string;
  /**
   * Free-text search matched against title and locationName.
   * Firestore does not natively support full-text search; this is handled
   * client-side via Algolia or a Firestore compound query on exact prefixes.
   */
  readonly search?: string;
  /** Only return needs updated after this ISO timestamp. */
  readonly updatedAfter?: string;
}
