/**
 * @module api
 *
 * Types for API request/response contracts, Firestore collection names,
 * Realtime Database feed shapes, and webhook events.
 *
 * All API routes in apps/web/app/api/ return `ApiResponse<T>`.
 * All paginated routes return `ApiResponse<PaginatedResponse<T>>`.
 */

// ---------------------------------------------------------------------------
// API error codes
// ---------------------------------------------------------------------------

/**
 * Exhaustive set of machine-readable error codes returned in ApiError.code.
 *
 * Clients should switch on this value to decide how to handle errors:
 *   - AUTH_REQUIRED / SESSION_EXPIRED → redirect to /login
 *   - FORBIDDEN                       → show "access denied" message
 *   - VALIDATION_ERROR                → highlight form fields
 *   - RATE_LIMITED                    → show retry-after countdown
 *   - NOT_FOUND                       → show 404 state
 *   - CONFLICT                        → show "already exists" message
 *   - UPSTREAM_ERROR                  → show generic "try again" message
 */
export type ApiErrorCode =
  // Auth
  | 'AUTH_REQUIRED'      // No session cookie present
  | 'SESSION_EXPIRED'    // Session cookie exists but is expired / revoked
  | 'INVALID_TOKEN'      // Firebase ID token verification failed
  | 'FORBIDDEN'          // User authenticated but lacks required role
  // Input
  | 'VALIDATION_ERROR'   // Zod schema validation failed (see details for field errors)
  | 'MISSING_FIELD'      // Required field absent from request body
  | 'INVALID_FORMAT'     // Field present but wrong type / format
  // Resources
  | 'NOT_FOUND'          // Requested document does not exist
  | 'CONFLICT'           // Unique constraint violation (e.g. duplicate report)
  // Rate limiting
  | 'RATE_LIMITED'       // Too many requests — see Retry-After header
  // Upstream services
  | 'GEMINI_ERROR'       // Gemini API call failed after retries
  | 'MAPS_ERROR'         // Google Maps API call failed
  | 'FCM_ERROR'          // Firebase Cloud Messaging delivery failed
  | 'FIRESTORE_ERROR'    // Unexpected Firestore read/write error
  // General
  | 'UPSTREAM_ERROR'     // Any third-party service error not covered above
  | 'INTERNAL_ERROR';    // Unexpected server error (logged, should be investigated)

// ---------------------------------------------------------------------------
// Core response wrappers
// ---------------------------------------------------------------------------

/**
 * Standard envelope for every API response.
 *
 * Successes:   { success: true,  data: T,    error: null }
 * Failures:    { success: false, data: null, error: ApiError }
 *
 * `requestId` is always present — it matches the `x-request-id` response
 * header and the structured log entry for distributed tracing.
 *
 * @example
 * const res = await fetch('/api/needs');
 * const body: ApiResponse<PaginatedResponse<CanonicalNeed>> = await res.json();
 * if (!body.success) {
 *   console.error(body.error.code, body.requestId);
 * }
 */
export interface ApiResponse<T> {
  /**
   * True when the operation succeeded and `data` is populated.
   * False when an error occurred and `error` is populated.
   */
  readonly success: boolean;
  /**
   * The response payload on success.
   * Null on failure.
   */
  readonly data: T | null;
  /**
   * Structured error on failure.
   * Null on success.
   */
  readonly error: ApiError | null;
  /**
   * UUID v4 correlation ID that ties this response to a specific
   * server request log entry.  Include in bug reports.
   */
  readonly requestId: string;
}

/**
 * Paginated list response — always nested inside ApiResponse<T>.
 *
 * Pagination is cursor-based in the production Firestore queries, but the
 * API surface exposes offset/page numbers for simpler client integration.
 *
 * @example
 * const body: ApiResponse<PaginatedResponse<CanonicalNeed>> = await res.json();
 * if (body.success && body.data !== null) {
 *   const { items, hasMore, page } = body.data;
 * }
 */
export interface PaginatedResponse<T> {
  /** The items on this page. */
  readonly items: readonly T[];
  /** Total number of items across all pages (may be approximate for large sets). */
  readonly total: number;
  /** 1-indexed current page number. */
  readonly page: number;
  /** Maximum number of items per page. */
  readonly pageSize: number;
  /**
   * True when more items exist beyond this page.
   * Use this flag rather than computing `page * pageSize < total` to avoid
   * off-by-one errors when items are added during pagination.
   */
  readonly hasMore: boolean;
}

/**
 * Structured error included in failed ApiResponse envelopes.
 *
 * Clients should use `code` for programmatic handling and `message` for
 * display.  Never expose `details` to end users — it may contain field
 * names or internal identifiers.
 */
export interface ApiError {
  /**
   * Machine-readable error code.
   * Used for programmatic error handling and analytics.
   */
  readonly code: ApiErrorCode;
  /**
   * Human-readable error message safe to display in the UI.
   * English only — the client is responsible for localisation.
   */
  readonly message: string;
  /**
   * Structured error context.
   * For VALIDATION_ERROR: a map of field name → array of error messages.
   * For other errors: arbitrary debugging information.
   * Never expose this to end users.
   */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * HTTP status code that was set on the response.
   * Repeated here so clients that parse only the JSON body have it available.
   */
  readonly statusCode: number;
}

// ---------------------------------------------------------------------------
// Pagination input
// ---------------------------------------------------------------------------

/**
 * Standard query parameters for paginated list endpoints.
 * Used in GET /api/needs, GET /api/volunteers, GET /api/resources, etc.
 */
export interface PaginationParams {
  /**
   * 1-indexed page number.
   * @default 1
   */
  readonly page?: number;
  /**
   * Items per page.
   * Clamped to [1, 50] server-side.
   * @default 20
   */
  readonly pageSize?: number;
  /**
   * Field to sort by.
   * Must be one of the sortable fields accepted by the specific endpoint.
   */
  readonly sortBy?: string;
  /**
   * Sort direction.
   * @default 'desc'
   */
  readonly sortOrder?: SortOrder;
}

/**
 * Sort direction for paginated queries.
 */
export type SortOrder = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Firestore collection registry
// ---------------------------------------------------------------------------

/**
 * Authoritative map of Firestore collection names.
 *
 * Import this constant rather than using raw string literals so that
 * collection renames are caught at compile time across the entire codebase.
 *
 * @example
 * import { COLLECTIONS } from '@rahatnet/types';
 * const snap = await getDoc(doc(db, COLLECTIONS.NEEDS, needId));
 */
export const COLLECTIONS = {
  /** /users/{uid} — all user profiles (citizens, volunteers, coordinators) */
  USERS: 'users',
  /** /rawReports/{reportId} — citizen submissions before AI processing */
  RAW_REPORTS: 'rawReports',
  /** /needs/{needId} — AI-deduplicated canonical needs */
  NEEDS: 'needs',
  /** /assignments/{assignmentId} — volunteer task assignments */
  ASSIGNMENTS: 'assignments',
  /** /disasterEvents/{eventId} — declared disaster events */
  DISASTER_EVENTS: 'disasterEvents',
  /** /resources/{resourceId} — physical relief resources */
  RESOURCES: 'resources',
  /** /imdAlerts/{alertId} — raw IMD / NDMA alert documents */
  IMD_ALERTS: 'imdAlerts',
  /** /alertTriggers/{triggerId} — platform activation trigger records */
  ALERT_TRIGGERS: 'alertTriggers',
  /**
   * /analytics/{docId} — aggregated metrics documents written by Cloud Functions.
   * Not queried directly by the web app — use GET /api/analytics instead.
   */
  ANALYTICS: 'analytics',
} as const;

/** Union of all valid Firestore collection names. */
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// ---------------------------------------------------------------------------
// Realtime Database feed types
// ---------------------------------------------------------------------------

/**
 * Root structure of the Firebase Realtime Database.
 *
 * The RTDB is used for low-latency real-time data that changes frequently
 * and does not need the full document model of Firestore.
 *
 * Full type:
 *   /liveNeedsFeed/{needId}       → RealtimeNeedFeedItem
 *   /volunteerLocations/{uid}     → RealtimeVolunteerLocation
 *   /disasterAlerts/{alertId}     → RealtimeDisasterAlert
 */
export interface RealtimeDatabase {
  readonly liveNeedsFeed: Readonly<Record<string, RealtimeNeedFeedItem>>;
  readonly volunteerLocations: Readonly<Record<string, RealtimeVolunteerLocation>>;
  readonly disasterAlerts: Readonly<Record<string, RealtimeDisasterAlert>>;
}

/**
 * Minimal need projection pushed to the Realtime DB feed.
 *
 * The full CanonicalNeed lives in Firestore.  The RTDB copy contains only
 * the fields needed to render the war-room heatmap and priority queue
 * without querying Firestore on every update.
 *
 * RTDB path: /liveNeedsFeed/{needId}
 */
export interface RealtimeNeedFeedItem {
  /** Short title for the map tooltip. */
  readonly title: string;
  /** Need category for icon selection. */
  readonly type: string;
  /** Severity for pin colour. */
  readonly severity: string;
  /** Urgency score 1–10 for queue sorting. */
  readonly urgencyScore: number;
  /** Current lifecycle status. */
  readonly status: string;
  /** Latitude for map pin placement. */
  readonly lat: number;
  /** Longitude for map pin placement. */
  readonly lng: number;
  /**
   * Unix millisecond timestamp of last update.
   * Used to sort the priority queue by staleness.
   */
  readonly updatedAt: number;
}

/**
 * Volunteer GPS location — written by the volunteer app every 30 seconds
 * while the volunteer is available.
 *
 * RTDB path: /volunteerLocations/{uid}
 */
export interface RealtimeVolunteerLocation {
  /** Latitude in decimal degrees. */
  readonly lat: number;
  /** Longitude in decimal degrees. */
  readonly lng: number;
  /**
   * Compass heading in degrees (0 = North, 90 = East).
   * Used to orient the volunteer arrow on the war-room map.
   */
  readonly heading: number;
  /** Speed in metres per second. 0 when stationary. */
  readonly speed: number;
  /** Whether the volunteer is currently accepting tasks. */
  readonly isAvailable: boolean;
  /**
   * Unix millisecond timestamp of last write.
   * Locations older than 30 minutes are treated as OFFLINE.
   */
  readonly updatedAt: number;
}

/**
 * Disaster alert pushed to the RTDB so all connected clients see it
 * immediately without a Firestore query.
 *
 * RTDB path: /disasterAlerts/{alertId}
 */
export interface RealtimeDisasterAlert {
  /** Event name for display in the alert banner. */
  readonly name: string;
  /** Disaster type for icon selection. */
  readonly type: string;
  /** Severity string for banner colour. */
  readonly severity: string;
  /** District names for the alert subtitle. */
  readonly districts: readonly string[];
  /**
   * Unix millisecond timestamp when the alert was issued.
   * Used to dismiss stale alerts after their validity period.
   */
  readonly issuedAt: number;
}

// ---------------------------------------------------------------------------
// Webhook events (Cloud Functions → external integrations)
// ---------------------------------------------------------------------------

/**
 * Union of all webhook event types emitted by RahatNet Cloud Functions.
 * Discriminated by the `type` field.
 *
 * External systems (NGO dashboards, government portals) can register a
 * webhook endpoint to receive these events in real time.
 */
export type WebhookEvent =
  | NeedCreatedEvent
  | NeedResolvedEvent
  | DisasterActivatedEvent
  | VolunteerDispatchedEvent;

/** Base fields shared by all webhook events. */
interface WebhookEventBase {
  /**
   * Unique event ID (UUID v4).
   * Can be used for idempotent processing of webhook deliveries.
   */
  readonly id: string;
  /**
   * ISO 8601 timestamp when the event was emitted.
   */
  readonly timestamp: string;
  /** API version of the webhook payload shape. */
  readonly apiVersion: '2025-01';
  /** ID of the DisasterEvent this event belongs to. */
  readonly disasterEventId: string;
}

/** Emitted when a new CanonicalNeed is created by the AI pipeline. */
export interface NeedCreatedEvent extends WebhookEventBase {
  readonly type: 'need.created';
  readonly needId: string;
  readonly needType: string;
  readonly severity: string;
  readonly urgencyScore: number;
  readonly locationName: string;
  readonly affectedCount: number;
}

/** Emitted when a CanonicalNeed transitions to RESOLVED. */
export interface NeedResolvedEvent extends WebhookEventBase {
  readonly type: 'need.resolved';
  readonly needId: string;
  readonly needType: string;
  /**
   * Minutes from need creation to resolution.
   * Key metric for impact reports.
   */
  readonly responseTimeMinutes: number;
  readonly volunteerId: string;
}

/** Emitted when a DisasterEvent is activated (status → ACTIVE). */
export interface DisasterActivatedEvent extends WebhookEventBase {
  readonly type: 'disaster.activated';
  readonly disasterType: string;
  readonly severity: string;
  readonly affectedDistricts: readonly string[];
  readonly activationMode: 'AUTOMATIC' | 'MANUAL_CONFIRMED';
}

/** Emitted when a volunteer is dispatched to a need. */
export interface VolunteerDispatchedEvent extends WebhookEventBase {
  readonly type: 'volunteer.dispatched';
  readonly assignmentId: string;
  readonly needId: string;
  readonly needType: string;
  readonly volunteerDistrict: string;
  readonly estimatedArrivalMinutes: number;
}
