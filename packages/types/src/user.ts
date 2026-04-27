/**
 * @module user
 *
 * Types for all user profiles in RahatNet.
 *
 * Three distinct personas interact with the platform:
 *
 *  CitizenProfile   — submits needs via the mobile PWA.
 *  VolunteerProfile — accepts tasks, navigates to locations, marks completion.
 *  CoordinatorProfile — manages the war-room dashboard, assigns volunteers,
 *                        allocates resources.  ADMIN extends COORDINATOR.
 *
 * All profiles share a UserProfile base and are discriminated by the `role`
 * field.  This lets you write exhaustive switch statements:
 *
 * @example
 * function getHome(profile: AnyUserProfile): string {
 *   switch (profile.role) {
 *     case UserRole.CITIZEN:     return '/citizen/report';
 *     case UserRole.VOLUNTEER:   return '/volunteer/tasks';
 *     case UserRole.COORDINATOR: return '/coordinator/war-room';
 *     case UserRole.ADMIN:       return '/coordinator/war-room';
 *   }
 * }
 */

import type { Timestamp } from 'firebase/firestore';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Application role — persisted as a Firebase Auth custom claim and in
 * the Firestore `users/{uid}.role` field.
 * Controls route access, UI variant, and API permissions.
 */
export enum UserRole {
  /** Citizen using the need-reporting PWA. The default role on sign-up. */
  CITIZEN = 'CITIZEN',
  /** Volunteer responding to assigned tasks on the ground. */
  VOLUNTEER = 'VOLUNTEER',
  /**
   * NGO or government coordinator managing the war-room dashboard.
   * Can read all needs, assign volunteers, and allocate resources.
   */
  COORDINATOR = 'COORDINATOR',
  /**
   * Platform administrator with all COORDINATOR rights plus the ability
   * to manage disaster events, promote users, and access analytics.
   */
  ADMIN = 'ADMIN',
}

/**
 * Physical skills a volunteer registers during onboarding.
 * Used by the dispatch algorithm to match volunteers to need types.
 *
 * Skill → Need type mapping (primary / secondary):
 *   BOAT_OPERATOR, RESCUE_SWIMMER → RESCUE (primary)
 *   DRIVER                        → RESCUE, FOOD (secondary)
 *   DOCTOR, NURSE                 → MEDICINE (primary)
 *   COOK                          → FOOD (primary)
 *   TRANSLATOR                    → all types (language support)
 *   COUNSELLOR                    → MENTAL_HEALTH (primary)
 *   ELECTRICIAN, CARPENTER        → INFRASTRUCTURE (primary)
 */
export enum VolunteerSkill {
  /** Licensed to operate motorboats or country boats in flood conditions. */
  BOAT_OPERATOR = 'BOAT_OPERATOR',
  /** MBBS or equivalent qualified physician. */
  DOCTOR = 'DOCTOR',
  /** Registered nurse or paramedic. */
  NURSE = 'NURSE',
  /** Experienced in bulk cooking for large groups. */
  COOK = 'COOK',
  /** Fluent in two or more regional languages; can translate for victims. */
  TRANSLATOR = 'TRANSLATOR',
  /** Trained open-water or lifeguard swimmer. */
  RESCUE_SWIMMER = 'RESCUE_SWIMMER',
  /** Licensed driver with experience in 4WD or heavy vehicles. */
  DRIVER = 'DRIVER',
  /** Trained mental health counsellor or psychosocial support worker. */
  COUNSELLOR = 'COUNSELLOR',
  /** Qualified electrician — for power restoration and generator operation. */
  ELECTRICIAN = 'ELECTRICIAN',
  /** Skilled carpenter — for emergency shelter construction and repair. */
  CARPENTER = 'CARPENTER',
}

/**
 * BCP-47 language codes for the Indian languages supported by RahatNet.
 * Used for UI localisation and volunteer-to-citizen language matching.
 */
export enum Language {
  /** हिंदी — spoken by ~600 million people across North India. */
  HINDI = 'hi',
  /** తెలుగు — official language of Andhra Pradesh and Telangana. */
  TELUGU = 'te',
  /** தமிழ் — official language of Tamil Nadu. */
  TAMIL = 'ta',
  /** ಕನ್ನಡ — official language of Karnataka. */
  KANNADA = 'kn',
  /** বাংলা — official language of West Bengal. */
  BENGALI = 'bn',
  /** मराठी — official language of Maharashtra. */
  MARATHI = 'mr',
  /** ગુજરાતી — official language of Gujarat. */
  GUJARATI = 'gu',
  /** മലയാളം — official language of Kerala (primary disaster-prone state). */
  MALAYALAM = 'ml',
  /** English — used as the internal processing language for AI pipeline. */
  ENGLISH = 'en',
}

// ---------------------------------------------------------------------------
// Narrow string literals
// ---------------------------------------------------------------------------

/**
 * Coordinator verification status of a volunteer profile.
 * A volunteer can only receive task assignments when status is VERIFIED.
 */
export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

/**
 * Onboarding completion stage.
 * Tracks whether a new user has finished setting up their profile.
 */
export type OnboardingStatus =
  | 'NOT_STARTED'
  | 'ROLE_SELECTED'
  | 'PROFILE_COMPLETE'
  | 'COMPLETED';

/**
 * Real-time availability of a volunteer.
 * Only AVAILABLE volunteers appear in dispatch algorithm results.
 */
export type VolunteerAvailabilityStatus =
  | 'AVAILABLE'    // actively accepting tasks
  | 'BUSY'         // has an active task assignment
  | 'UNAVAILABLE'  // manually toggled off
  | 'OFFLINE';     // last location update > 30 minutes ago

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/**
 * Optional contact information beyond Firebase Auth's phone/email.
 * Coordinators can use this to reach volunteers via WhatsApp or alternate lines.
 */
export interface ContactInfo {
  /** WhatsApp number (may differ from login phone, include country code). */
  readonly whatsapp: string | null;
  /** Alternate phone number or landline. */
  readonly alternatePhone: string | null;
}

/**
 * Aggregate performance statistics for a volunteer.
 * Computed and cached in the Firestore profile to avoid expensive aggregation
 * queries on every dispatch request.
 */
export interface VolunteerStats {
  /** Total tasks accepted and completed (not counting declines or failures). */
  readonly tasksCompleted: number;
  /**
   * Fraction of assigned tasks that were completed (vs declined/failed).
   * Range: 0 to 1.  Used as a factor in the dispatch scoring algorithm.
   */
  readonly completionRate: number;
  /**
   * Average rating given by coordinators after task completion.
   * Scale 1–5.  Null until at least one task is completed.
   */
  readonly averageRating: number | null;
  /**
   * Average minutes from task assignment notification to volunteer arrival.
   * Measures real-world response speed.  Null until first completion.
   */
  readonly avgResponseTimeMinutes: number | null;
  /** ISO timestamp of the most recently completed task. Null if no tasks yet. */
  readonly lastActiveAt: string | null;
}

/**
 * User preferences for push and in-app notifications.
 * Stored in the Firestore profile and read by the FCM notification service.
 */
export interface NotificationPreferences {
  /** Receive push notifications for new task assignments. Default: true. */
  readonly taskAssignments: boolean;
  /** Receive push when disaster alerts activate in the user's district. Default: true. */
  readonly disasterAlerts: boolean;
  /** Receive in-app status updates when a submitted report changes state. Default: true. */
  readonly reportStatusUpdates: boolean;
  /**
   * Quiet hours during which no push notifications are sent.
   * Both values are local-time hours in 24 h format (e.g. 22, 7).
   * Null means no quiet hours.
   */
  readonly quietHours: {
    readonly startHour: number;
    readonly endHour: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Base profile
// ---------------------------------------------------------------------------

/**
 * Base profile fields shared by every user regardless of role.
 *
 * Firestore path: /users/{uid}
 */
export interface UserProfile {
  /** Firebase Auth UID — also the Firestore document ID. */
  readonly uid: string;
  /**
   * E.164-formatted phone number used for Firebase Phone Auth.
   * e.g. '+919876543210'.  Null for users who signed in with Google.
   */
  readonly phoneNumber: string | null;
  /**
   * Email address.  Present for Google sign-in users.
   * Null for phone-only sign-in.
   */
  readonly email: string | null;
  /** Display name sourced from Firebase Auth or entered during onboarding. */
  readonly displayName: string;
  /** Firebase Auth profile photo URL or null. */
  readonly photoURL: string | null;
  /** Application role — also stored as a Firebase Auth custom claim. */
  readonly role: UserRole;
  /** BCP-47 code of the user's preferred UI language. */
  readonly language: Language;
  /**
   * Administrative district the user registered from.
   * Used to match volunteers to disaster zones and scope coordinator dashboards.
   * e.g. 'Ernakulam', 'Wayanad'.
   */
  readonly district: string;
  /**
   * Indian state for the district above.
   * e.g. 'Kerala', 'Assam'.
   */
  readonly state: string;
  /**
   * Firebase Cloud Messaging registration token for push notifications.
   * Rotated by the client on each app launch; may be null if the user
   * has denied notification permissions.
   */
  readonly fcmToken: string | null;
  /** Onboarding completion stage. Gating for role-specific feature access. */
  readonly onboardingStatus: OnboardingStatus;
  /** Optional supplementary contact details. */
  readonly contactInfo?: ContactInfo;
  /** Push notification preferences. Null means all defaults (all enabled). */
  readonly notificationPreferences: NotificationPreferences | null;
  /** Firestore server timestamp of first account creation. */
  readonly createdAt: Timestamp;
  /** Firestore server timestamp of last profile update. */
  readonly updatedAt: Timestamp;
  /**
   * True when this document was inserted by the demo seed script.
   * Used by the clear-demo script to safely delete only demo data.
   */
  readonly isDemoData?: boolean;
}

// ---------------------------------------------------------------------------
// Role-specific profiles
// ---------------------------------------------------------------------------

/**
 * Profile for citizens who report needs via the mobile PWA.
 *
 * Citizens have the least privilege: they can only submit reports and
 * track the status of their own submissions.
 *
 * Firestore path: /users/{uid}  (role === CITIZEN)
 */
export interface CitizenProfile extends UserProfile {
  readonly role: UserRole.CITIZEN;
  /**
   * IDs of raw reports submitted by this citizen.
   * Denormalised for fast access on the /citizen/status page.
   * The authoritative list lives in /rawReports where reporterId === uid.
   */
  readonly reportIds: readonly string[];
}

/**
 * Profile for volunteers who respond to assigned tasks.
 *
 * Firestore path: /users/{uid}  (role === VOLUNTEER)
 */
export interface VolunteerProfile extends UserProfile {
  readonly role: UserRole.VOLUNTEER;
  /**
   * Skills registered during onboarding.  At least one skill is required.
   * Determines which need types the volunteer appears in dispatch results for.
   */
  readonly skills: readonly VolunteerSkill[];
  /**
   * Languages the volunteer can communicate in.  Used to compute the
   * language match score in the dispatch algorithm so victims can be
   * reached in their native language.
   */
  readonly languages: readonly Language[];
  /**
   * Real-time availability status.
   * Toggled by the volunteer via the availability button in the volunteer app.
   * Set to BUSY automatically when a task is assigned and accepted.
   * Set to OFFLINE automatically when the live location hasn't been updated
   * for more than 30 minutes.
   */
  readonly availabilityStatus: VolunteerAvailabilityStatus;
  /**
   * Whether the volunteer is currently accepting tasks.
   * Convenience alias for availabilityStatus === 'AVAILABLE', kept for
   * backwards compatibility with the Realtime Database rules and dispatch query.
   */
  readonly isAvailable: boolean;
  /**
   * Coordinator-verified status.  Only VERIFIED volunteers receive task
   * assignments.  Unverified volunteers can register and navigate to tasks
   * but the dispatch algorithm excludes them.
   */
  readonly verificationStatus: VerificationStatus;
  /**
   * Aggregate performance statistics computed and cached here to avoid
   * expensive aggregation on every dispatch request.
   */
  readonly stats: VolunteerStats;
  /**
   * ID of the currently active Assignment, if any.
   * Null when the volunteer is available for a new task.
   */
  readonly activeAssignmentId: string | null;
}

/**
 * Profile for NGO / NDRF / government coordinators managing the war room.
 *
 * Coordinators can see all needs across their assigned disasters, assign
 * volunteers, allocate resources, and export reports for NDRF/state government.
 *
 * ADMIN extends COORDINATOR with additional platform management capabilities
 * (promote users, create disaster events, view cross-district analytics).
 *
 * Firestore path: /users/{uid}  (role === COORDINATOR | ADMIN)
 */
export interface CoordinatorProfile extends UserProfile {
  readonly role: UserRole.COORDINATOR | UserRole.ADMIN;
  /**
   * IDs of DisasterEvent documents this coordinator is responsible for.
   * Empty array means the coordinator can see all events (used for ADMINs).
   */
  readonly assignedDisasters: readonly string[];
  /** Name of the NGO, government department, or military unit. */
  readonly organizationName: string;
  /** Job title or rank within the organisation. */
  readonly designation: string;
  /**
   * Administrative district(s) this coordinator oversees.
   * Drives the default map viewport and queue filter in the war room.
   */
  readonly managedDistricts: readonly string[];
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all profile types.
 * Use this when you need to accept any user and narrow by role:
 *
 * @example
 * function getSkills(profile: AnyUserProfile): readonly VolunteerSkill[] {
 *   if (profile.role === UserRole.VOLUNTEER) {
 *     return profile.skills; // narrowed to VolunteerProfile
 *   }
 *   return [];
 * }
 */
export type AnyUserProfile = CitizenProfile | VolunteerProfile | CoordinatorProfile;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/**
 * Mutable fields that a user can update from the profile settings page.
 * Excludes uid, role, createdAt, and fields only set by server-side logic.
 */
export type UserProfileUpdatePayload = Partial<
  Pick<
    UserProfile,
    | 'displayName'
    | 'photoURL'
    | 'language'
    | 'district'
    | 'state'
    | 'fcmToken'
    | 'contactInfo'
    | 'notificationPreferences'
  >
>;

/**
 * Volunteer-specific mutable fields.
 * Used in PATCH /api/volunteers/:uid.
 */
export type VolunteerProfileUpdatePayload = UserProfileUpdatePayload &
  Partial<
    Pick<VolunteerProfile, 'skills' | 'languages' | 'isAvailable' | 'availabilityStatus'>
  >;
