/**
 * @module @rahatnet/types
 *
 * Public API of the shared type package.
 *
 * All enums, interfaces, type aliases, and runtime helpers used across
 * apps/web and apps/functions are re-exported from this single entry point.
 *
 * Import pattern:
 * @example
 * import type { CanonicalNeed, NeedType, UserRole } from '@rahatnet/types';
 * import { COLLECTIONS, toUrgencyScore }           from '@rahatnet/types';
 *
 * The `import type` syntax is preferred for pure-type imports to ensure zero
 * runtime cost in compiled output.  Runtime values (enums, COLLECTIONS,
 * toUrgencyScore) must use a plain `import`.
 *
 * Module breakdown:
 *   need       — RawReport, CanonicalNeed, NeedCluster, NeedAssignment + enums
 *   user       — CitizenProfile, VolunteerProfile, CoordinatorProfile + enums
 *   disaster   — DisasterEvent, DisasterZone, IMDAlert, AlertTrigger + enums
 *   assignment — Assignment, AssignmentUpdate, MatchFactors + enums
 *   resource   — Resource, ResourceAllocation, ResourceSummary + enums
 *   api        — ApiResponse, ApiError, PaginatedResponse, COLLECTIONS + enums
 */

// ---------------------------------------------------------------------------
// need.ts
// ---------------------------------------------------------------------------
export {
  // Enums (runtime values)
  NeedType,
  NeedStatus,
  NeedSeverity,
  // Runtime helper
  toUrgencyScore,
} from './need';

export type {
  // Branded primitive
  UrgencyScore,
  // Shared sub-type
  GeoPoint,
  AiProcessingMeta,
  // Core interfaces
  RawReport,
  CanonicalNeed,
  NeedCluster,
  NeedAssignment,
  // Utility types
  RawReportStatus,
  NeedUpdatePayload,
  NeedFilters,
} from './need';

// ---------------------------------------------------------------------------
// user.ts
// ---------------------------------------------------------------------------
export {
  // Enums (runtime values)
  UserRole,
  VolunteerSkill,
  Language,
} from './user';

export type {
  // Narrow string literals
  VerificationStatus,
  OnboardingStatus,
  VolunteerAvailabilityStatus,
  // Sub-interfaces
  ContactInfo,
  VolunteerStats,
  NotificationPreferences,
  // Core interfaces
  UserProfile,
  CitizenProfile,
  VolunteerProfile,
  CoordinatorProfile,
  // Discriminated union
  AnyUserProfile,
  // Utility types
  UserProfileUpdatePayload,
  VolunteerProfileUpdatePayload,
} from './user';

// ---------------------------------------------------------------------------
// disaster.ts
// ---------------------------------------------------------------------------
export {
  // Enums (runtime values)
  DisasterType,
  DisasterSeverity,
  DisasterStatus,
  DisasterPhase,
  IMDColorCode,
} from './disaster';

export type {
  // Sub-interfaces
  BoundingBox,
  DisasterStats,
  // Core interfaces
  DisasterEvent,
  DisasterZone,
  IMDAlert,
  AlertTrigger,
  // Utility types
  DisasterFilters,
  DisasterEventUpdatePayload,
} from './disaster';

// ---------------------------------------------------------------------------
// assignment.ts
// ---------------------------------------------------------------------------
export {
  // Enums (runtime values)
  AssignmentStatus,
  DeclineReason,
} from './assignment';

export type {
  // Sub-interfaces
  MatchFactors,
  AssignmentMetrics,
  AssignmentNotification,
  // Core interfaces
  Assignment,
  AssignmentUpdate,
} from './assignment';

// ---------------------------------------------------------------------------
// resource.ts
// ---------------------------------------------------------------------------
export {
  // Enums (runtime values)
  ResourceType,
  ResourceStatus,
  ResourceCondition,
  ResourceAllocationStatus,
} from './resource';

export type {
  // Core interfaces
  Resource,
  ResourceAllocation,
  // Utility types
  ResourceSummary,
  ResourceUpdatePayload,
} from './resource';

// ---------------------------------------------------------------------------
// api.ts
// ---------------------------------------------------------------------------
export {
  // Runtime constant
  COLLECTIONS,
} from './api';

export type {
  // Error codes
  ApiErrorCode,
  // Response wrappers
  ApiResponse,
  ApiError,
  PaginatedResponse,
  // Pagination input
  PaginationParams,
  SortOrder,
  // Collection registry
  CollectionName,
  // Realtime Database
  RealtimeDatabase,
  RealtimeNeedFeedItem,
  RealtimeVolunteerLocation,
  RealtimeDisasterAlert,
  // Webhook events
  WebhookEvent,
  NeedCreatedEvent,
  NeedResolvedEvent,
  DisasterActivatedEvent,
  VolunteerDispatchedEvent,
} from './api';
