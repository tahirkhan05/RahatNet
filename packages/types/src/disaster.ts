/**
 * @module disaster
 *
 * Types for disaster events, geographic zones, and alert triggers.
 *
 * A DisasterEvent is the root context that scopes every need, assignment,
 * volunteer deployment, and resource allocation.  It is either created:
 *  - Automatically by the IMD alert poller when a RED or ORANGE alert is issued.
 *  - Manually by a coordinator or admin in the war-room dashboard.
 *
 * Lifecycle:
 *   IMDAlert received → AlertTrigger created → DisasterEvent (status: MONITORING)
 *       ↓  First needs start coming in
 *   DisasterEvent (status: ACTIVE)
 *       ↓  Field situation stabilises
 *   DisasterEvent (status: WINDING_DOWN)
 *       ↓  All needs resolved, final report exported
 *   DisasterEvent (status: RESOLVED)
 */

import type { Timestamp } from 'firebase/firestore';
import type { GeoPoint } from './need';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Category of natural or man-made disaster.
 * Drives default resource pre-positioning and skill requirements.
 */
export enum DisasterType {
  /**
   * River or coastal flooding — the most common disaster type in India.
   * Primary need: RESCUE (boat operators), SHELTER, FOOD.
   */
  FLOOD = 'FLOOD',
  /**
   * Tropical cyclone / hurricane — coastal states (Odisha, AP, Tamil Nadu).
   * Primary need: RESCUE, SHELTER, INFRASTRUCTURE.
   */
  CYCLONE = 'CYCLONE',
  /**
   * Seismic event — Himalayan belt and Deccan Plateau fault zones.
   * Primary need: RESCUE (rubble removal), MEDICINE.
   */
  EARTHQUAKE = 'EARTHQUAKE',
  /**
   * Landslide or mudslide — common in Kerala, Uttarakhand, Northeast India.
   * Primary need: RESCUE, INFRASTRUCTURE.
   */
  LANDSLIDE = 'LANDSLIDE',
  /**
   * Agricultural drought — slow-onset, coordinated through district collectors.
   * Primary need: FOOD, MEDICINE (malnutrition).
   */
  DROUGHT = 'DROUGHT',
  /**
   * Wildfire or urban fire — Chhattisgarh forests, industrial areas.
   * Primary need: RESCUE, MEDICINE.
   */
  FIRE = 'FIRE',
  /** Any disaster type not covered by the specific categories above. */
  OTHER = 'OTHER',
}

/**
 * Overall severity of a disaster event.
 * Mapped from the IMD alert colour and updated as the situation evolves.
 */
export enum DisasterSeverity {
  /** Localised impact; normal response protocols. */
  LOW = 'LOW',
  /** District-level impact; district disaster management plan activated. */
  MODERATE = 'MODERATE',
  /** Multi-district; state disaster management plan activated. */
  SEVERE = 'SEVERE',
  /** Multi-state or national-level; NDRF deployment; central funds released. */
  CATASTROPHIC = 'CATASTROPHIC',
}

/**
 * Lifecycle status of a DisasterEvent.
 * Exposed as a typed enum so switch statements can be exhaustive.
 */
export enum DisasterStatus {
  /**
   * IMD alert received; platform activated; volunteers notified.
   * No needs have been submitted yet.
   */
  MONITORING = 'MONITORING',
  /**
   * Needs are being submitted; volunteers are dispatched.
   * War-room dashboard is live.
   */
  ACTIVE = 'ACTIVE',
  /**
   * Flood water receding; most critical needs addressed.
   * Remaining needs are NORMAL or LOW severity.
   */
  WINDING_DOWN = 'WINDING_DOWN',
  /**
   * All needs resolved or cancelled.
   * Impact report exported to NDRF/state government.
   * Event archived but still readable.
   */
  RESOLVED = 'RESOLVED',
}

/**
 * Operational phase within an ACTIVE disaster.
 * Drives default UI views and resource allocation recommendations.
 */
export enum DisasterPhase {
  /** Immediate response: rescues, medical emergencies. (0–24 h) */
  RESPONSE = 'RESPONSE',
  /** Stabilisation: food, shelter, medicines. (1–7 days) */
  RELIEF = 'RELIEF',
  /** Long-term: infrastructure repair, psychological support. (7+ days) */
  RECOVERY = 'RECOVERY',
}

/**
 * IMD (India Meteorological Department) alert colour codes.
 * Colour → action mapping:
 *   RED    → Take action (RahatNet auto-activates)
 *   ORANGE → Be prepared (RahatNet notifies coordinators)
 *   YELLOW → Be updated (RahatNet logs but does not activate)
 *   GREEN  → No warning (informational only)
 */
export enum IMDColorCode {
  /** Severe / catastrophic event — immediate activation. */
  RED = 'RED',
  /** Significant event — coordinator heads-up, volunteer pre-registration. */
  ORANGE = 'ORANGE',
  /** Watch-and-wait — no automatic action. */
  YELLOW = 'YELLOW',
  /** Clear conditions — no action required. */
  GREEN = 'GREEN',
}

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/**
 * Axis-aligned bounding box (AABB) for a geographic area.
 * Used to set the war-room map viewport and scope volunteer queries.
 */
export interface BoundingBox {
  /** Northern boundary, latitude in decimal degrees. */
  readonly north: number;
  /** Southern boundary, latitude in decimal degrees. */
  readonly south: number;
  /** Eastern boundary, longitude in decimal degrees. */
  readonly east: number;
  /** Western boundary, longitude in decimal degrees. */
  readonly west: number;
}

/**
 * Aggregate impact statistics for a DisasterEvent.
 * Updated by a Cloud Function whenever a need changes status or a volunteer
 * completes a task.  Used by the war-room header metrics bar.
 */
export interface DisasterStats {
  /** Total CanonicalNeed documents under this disaster event. */
  readonly totalNeeds: number;
  /** Needs with status RESOLVED. */
  readonly resolvedNeeds: number;
  /** Needs with status IN_PROGRESS. */
  readonly inProgressNeeds: number;
  /** Needs with status VERIFIED or ASSIGNED (awaiting volunteer). */
  readonly pendingNeeds: number;
  /** Number of VolunteerProfiles with isAvailable === true in affected districts. */
  readonly activeVolunteers: number;
  /**
   * Mean time in minutes from need creation to volunteer arrival (COMPLETED),
   * across all tasks completed during this disaster.
   * Null until at least one task is completed.
   */
  readonly avgResponseTimeMinutes: number | null;
  /** Total raw RawReport documents submitted (including duplicates). */
  readonly totalReports: number;
  /**
   * Percentage of reported needs that have been resolved.
   * Range 0–100.  Null until at least one need exists.
   */
  readonly resolutionRate: number | null;
}

// ---------------------------------------------------------------------------
// Core domain interfaces
// ---------------------------------------------------------------------------

/**
 * A declared disaster event — the root context for all RahatNet activity.
 *
 * Every need, assignment, and resource allocation belongs to exactly one
 * DisasterEvent.  Multiple simultaneous disasters are supported.
 *
 * Firestore path: /disasterEvents/{eventId}
 */
export interface DisasterEvent {
  /** Firestore document ID. */
  readonly id: string;
  /**
   * Human-readable event name.
   * Auto-generated format: "{DisasterType} Alert — {districts}, {state}"
   * e.g. "Flood Alert — Ernakulam, Wayanad, Kerala"
   */
  readonly name: string;
  /** Category of the disaster. */
  readonly type: DisasterType;
  /** Overall severity — updated as the situation evolves. */
  readonly severity: DisasterSeverity;
  /** Current lifecycle status. */
  readonly status: DisasterStatus;
  /** Current operational phase within the event. */
  readonly phase: DisasterPhase;
  /**
   * List of affected administrative districts by name.
   * e.g. ['Ernakulam', 'Wayanad', 'Idukki']
   */
  readonly affectedDistricts: readonly string[];
  /**
   * Indian state(s) affected.  Usually one, but Himalayan disasters often
   * cross state boundaries.
   */
  readonly affectedStates: readonly string[];
  /** Geographic bounding box used to set the default war-room map viewport. */
  readonly boundingBox: BoundingBox;
  /**
   * Firestore server timestamp when the event was created / platform activated.
   */
  readonly activatedAt: Timestamp;
  /**
   * Firebase Auth UID of the coordinator who manually activated,
   * or the string literal 'SYSTEM_AUTO' when triggered by the IMD poller.
   */
  readonly activatedBy: string;
  /**
   * Firestore server timestamp when the event was resolved.
   * Null while the event is still active.
   */
  readonly resolvedAt: Timestamp | null;
  /**
   * Firebase Auth UID of the coordinator who marked the event as resolved.
   * Null while still active.
   */
  readonly resolvedBy: string | null;
  /** Live impact statistics, updated in near-real-time by Cloud Functions. */
  readonly stats: DisasterStats;
  /**
   * URL of the official government / NDMA incident page for this disaster.
   * Null when no official link is available.
   */
  readonly officialUrl: string | null;
  /**
   * True when this document was inserted by the demo seed script.
   * Used by the clear-demo script to safely delete only demo data.
   */
  readonly isDemoData?: boolean;
}

/**
 * A geographic sub-zone within a disaster.
 *
 * Large disasters are divided into zones (e.g. per taluk or block) so
 * coordinators can delegate responsibility per zone and track coverage.
 *
 * Firestore path: /disasterEvents/{eventId}/zones/{zoneId}
 */
export interface DisasterZone {
  /** Firestore document ID. */
  readonly id: string;
  /** ID of the parent DisasterEvent. */
  readonly disasterEventId: string;
  /**
   * Human-readable zone name.
   * e.g. 'Aluva Block', 'North Ernakulam', 'Wayanad Tribal Belt'.
   */
  readonly name: string;
  /** Polygon vertices defining the zone boundary, in CW or CCW winding order. */
  readonly polygon: readonly GeoPoint[];
  /**
   * Centroid coordinate of the polygon.
   * Pre-computed to avoid repeated centroid calculation in map rendering.
   */
  readonly centroid: GeoPoint;
  /** Severity level specifically within this zone. */
  readonly severity: DisasterSeverity;
  /** Total CanonicalNeed count within this zone's polygon. */
  readonly needCount: number;
  /** Resolved need count within this zone. */
  readonly resolvedCount: number;
  /**
   * Firebase Auth UID of the coordinator responsible for this zone.
   * Null when unassigned (managed by any available coordinator).
   */
  readonly coordinatorId: string | null;
  /** Firestore server timestamp of last update to zone statistics. */
  readonly updatedAt: Timestamp;
}

/**
 * Raw alert object received from the IMD RSS/API feed or Google Alerts.
 *
 * A single IMD bulletin may contain alerts for multiple districts.  We
 * create one IMDAlert document per district so de-duplication and
 * disaster activation can be applied at district granularity.
 *
 * Firestore path: /imdAlerts/{alertId}
 */
export interface IMDAlert {
  /** Firestore document ID. */
  readonly id: string;
  /**
   * SHA-256 hash of "{alertType}:{district}:{issuedDate}" used to detect
   * and prevent processing the same alert twice from different feed sources.
   */
  readonly dedupHash: string;
  /** IMD colour code indicating severity. */
  readonly colorCode: IMDColorCode;
  /** Disaster type inferred from the alert text. */
  readonly alertType: DisasterType;
  /** Administrative districts named in the alert. */
  readonly districts: readonly string[];
  /** Indian state the alert covers. */
  readonly state: string;
  /**
   * Short headline extracted from the alert.
   * e.g. "Red Alert — Heavy to Extremely Heavy Rainfall — Ernakulam"
   */
  readonly headline: string;
  /** Full advisory text from the IMD bulletin. */
  readonly details: string;
  /** When the alert was issued, according to IMD. */
  readonly issuedAt: Timestamp;
  /**
   * When the alert expires, according to IMD.
   * After this time, if no new alert is issued, the platform enters WINDING_DOWN.
   */
  readonly validUntil: Timestamp;
  /**
   * Source identifier: 'IMD_RSS', 'NDMA_API', or 'GOOGLE_ALERTS'.
   * Stored for audit purposes and to tune source reliability weights.
   */
  readonly source: 'IMD_RSS' | 'NDMA_API' | 'GOOGLE_ALERTS';
  /**
   * Raw XML or JSON payload from the feed source.
   * Truncated to 2000 characters for storage efficiency.
   */
  readonly rawPayload: string;
  /**
   * Whether a DisasterEvent was activated in response to this alert.
   * Updated by the disasterActivation Cloud Function.
   */
  readonly activationTriggered: boolean;
}

/**
 * A processed alert trigger that activates the RahatNet platform.
 *
 * Created by the disasterActivation Cloud Function when it decides that
 * an IMD alert warrants platform activation (RED or ORANGE alerts only).
 *
 * Firestore path: /alertTriggers/{triggerId}
 */
export interface AlertTrigger {
  /** Firestore document ID. */
  readonly id: string;
  /** The IMDAlert that caused this trigger. Embedded for fast access. */
  readonly imdAlert: IMDAlert;
  /** ID of the DisasterEvent that was created or updated by this trigger. */
  readonly disasterEventId: string;
  /** Server timestamp when the trigger was processed. */
  readonly triggeredAt: Timestamp;
  /** Number of volunteer FCM notifications sent during activation. */
  readonly volunteersNotified: number;
  /** Number of coordinator FCM notifications sent during activation. */
  readonly coordinatorsNotified: number;
  /**
   * Whether the activation was fully automated or required manual confirmation.
   * ORANGE alerts require coordinator confirmation before volunteers are notified.
   */
  readonly activationMode: 'AUTOMATIC' | 'MANUAL_CONFIRMED';
  /** Any error encountered during activation (null on success). */
  readonly activationError: string | null;
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/**
 * Query filters for the GET /api/disasters endpoint.
 */
export interface DisasterFilters {
  /** Only return events with these statuses. */
  readonly statuses?: readonly DisasterStatus[];
  /** Only return events affecting these districts. */
  readonly districts?: readonly string[];
  /** Only return events of this disaster type. */
  readonly type?: DisasterType;
  /** Only return events activated after this ISO timestamp. */
  readonly activatedAfter?: string;
}

/**
 * Fields that a coordinator or admin may update on a DisasterEvent.
 */
export type DisasterEventUpdatePayload = Partial<
  Pick<
    DisasterEvent,
    | 'name'
    | 'severity'
    | 'status'
    | 'phase'
    | 'boundingBox'
    | 'affectedDistricts'
    | 'affectedStates'
    | 'resolvedAt'
    | 'resolvedBy'
    | 'officialUrl'
  >
>;
