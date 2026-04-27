/**
 * Test data factories for RahatNet.
 *
 * Every factory accepts optional `overrides` so individual tests can vary
 * only the fields they care about while keeping the rest at sensible defaults.
 *
 * Timestamps are plain objects that quack like Firestore Timestamps — enough
 * for the UI components and pure-logic modules that read `.seconds`.
 */

import {
  NeedType,
  NeedStatus,
  NeedSeverity,
  UserRole,
  Language,
  DisasterType,
  DisasterSeverity,
  DisasterStatus,
  DisasterPhase,
  AssignmentStatus,
  VolunteerSkill,
  DeclineReason,
} from '@rahatnet/types';
import type {
  CanonicalNeed,
  RawReport,
  UserProfile,
  VolunteerProfile,
  DisasterEvent,
  Assignment,
} from '@rahatnet/types';
import type { Timestamp } from 'firebase/firestore';
import type { VolunteerMatch, ScoreBreakdown } from '@/lib/ai/dispatch';
import type { RawReportCluster } from '@/lib/ai/deduplication';

// ---------------------------------------------------------------------------
// Timestamp stub
// ---------------------------------------------------------------------------

export function mockTimestamp(offsetMs = 0): Timestamp {
  const ms = Date.now() + offsetMs;
  return {
    seconds:     Math.floor(ms / 1000),
    nanoseconds: 0,
    toDate:      () => new Date(ms),
    toMillis:    () => ms,
    isEqual:     () => false,
    valueOf:     () => String(ms),
  } as unknown as Timestamp;
}

// ---------------------------------------------------------------------------
// RawReport
// ---------------------------------------------------------------------------

export function createMockRawReport(
  overrides: Partial<RawReport> = {},
): RawReport {
  return {
    id:                   `report-${Math.random().toString(36).slice(2)}`,
    reporterId:           `user-${Math.random().toString(36).slice(2)}`,
    type:                 NeedType.RESCUE,
    description:          'People are stranded on the rooftop and need immediate rescue',
    originalDescription:  'ആളുകൾ മേൽക്കൂരയിൽ കുടുങ്ങിക്കിടക്കുന്നു, ഉടനടി രക്ഷ ആവശ്യമാണ്',
    originalLanguage:     'ml',
    voiceNoteUrl:         null,
    photoUrls:            [],
    location:             { lat: 10.0167, lng: 76.3417 },
    locationName:         'Aluva, Ernakulam',
    affectedCount:        5,
    hasVulnerable:        false,
    status:               'PENDING',
    canonicalNeedId:      null,
    createdAt:            mockTimestamp(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CanonicalNeed
// ---------------------------------------------------------------------------

export function createMockNeed(
  overrides: Partial<CanonicalNeed> = {},
): CanonicalNeed {
  return {
    id:                   `need-${Math.random().toString(36).slice(2)}`,
    title:                'Rescue needed at Aluva Bridge — 5 people affected',
    description:          'People are stranded and need immediate rescue',
    type:                 NeedType.RESCUE,
    status:               NeedStatus.VERIFIED,
    severity:             NeedSeverity.CRITICAL,
    urgencyScore:         9 as CanonicalNeed['urgencyScore'],
    location:             { lat: 10.0167, lng: 76.3417 },
    locationName:         'Aluva, Ernakulam',
    affectedCount:        5,
    hasVulnerable:        true,
    sourceReportIds:      ['report-1', 'report-2'],
    reportCount:          3,
    assignedVolunteerId:  null,
    assignedAt:           null,
    resolvedAt:           null,
    disasterEventId:      'disaster-001',
    createdAt:            mockTimestamp(),
    updatedAt:            mockTimestamp(),
    aiProcessingMeta: {
      deduplicationConfidence: 0.92,
      urgencyFactors:          { keyword: 9, photo: 8, context: 9 },
      processingTimeMs:        1250,
      modelId:                 'gemini-1.5-flash',
      processedAt:             new Date().toISOString(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// UserProfile (citizen)
// ---------------------------------------------------------------------------

export function createMockUser(
  overrides: Partial<UserProfile> = {},
): UserProfile {
  return {
    uid:              `user-${Math.random().toString(36).slice(2)}`,
    phoneNumber:      '+919876543210',
    email:            null,
    displayName:      'Test Citizen',
    photoURL:         null,
    role:             UserRole.CITIZEN,
    language:         Language.ENGLISH,
    district:         'Ernakulam',
    state:            'Kerala',
    fcmToken:         null,
    onboardingStatus: 'COMPLETED',
    notificationPreferences: null,
    createdAt:        mockTimestamp(),
    updatedAt:        mockTimestamp(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VolunteerProfile
// ---------------------------------------------------------------------------

export function createMockVolunteer(
  overrides: Partial<VolunteerProfile> = {},
): VolunteerProfile {
  return {
    uid:                  `vol-${Math.random().toString(36).slice(2)}`,
    phoneNumber:          '+919876543211',
    email:                null,
    displayName:          'Test Volunteer',
    photoURL:             null,
    role:                 UserRole.VOLUNTEER,
    language:             Language.ENGLISH,
    district:             'Ernakulam',
    state:                'Kerala',
    fcmToken:             'fcm-token-test',
    onboardingStatus:     'COMPLETED',
    notificationPreferences: null,
    skills:               [VolunteerSkill.BOAT_OPERATOR, VolunteerSkill.RESCUE_SWIMMER],
    languages:            [Language.ENGLISH, Language.MALAYALAM],
    availabilityStatus:   'AVAILABLE',
    isAvailable:          true,
    verificationStatus:   'VERIFIED',
    activeAssignmentId:   null,
    stats: {
      tasksCompleted:          10,
      completionRate:          0.9,
      averageRating:           4.5,
      avgResponseTimeMinutes:  7,
      lastActiveAt:            new Date().toISOString(),
    },
    createdAt:            mockTimestamp(),
    updatedAt:            mockTimestamp(),
    ...overrides,
  } as unknown as VolunteerProfile;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export function createMockAssignment(
  overrides: Partial<Assignment> = {},
): Assignment {
  return {
    id:             `asgn-${Math.random().toString(36).slice(2)}`,
    needId:         'need-001',
    volunteerId:    'vol-001',
    coordinatorId:  'SYSTEM_AUTO',
    status:         AssignmentStatus.NOTIFIED,
    matchScore:     82,
    matchFactors: {
      distanceScore:           90,
      skillScore:              100,
      languageScore:           100,
      historyScore:            70,
      estimatedDrivingMinutes: 8,
    },
    message:        'Please proceed to Aluva Bridge immediately.',
    notification:   null,
    createdAt:      mockTimestamp(),
    acceptedAt:     null,
    arrivedAt:      null,
    completedAt:    null,
    declinedReason: null,
    declinedNote:   null,
    metrics:        null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VolunteerMatch (dispatch algorithm output)
// ---------------------------------------------------------------------------

export function createMockScoreBreakdown(
  overrides: Partial<ScoreBreakdown> = {},
): ScoreBreakdown {
  return {
    distanceScore:            90,
    skillScore:               100,
    languageScore:            100,
    historyScore:             70,
    compositeScore:           91,
    estimatedDrivingMinutes:  8,
    usedHaversineFallback:    false,
    ...overrides,
  };
}

export function createMockVolunteerMatch(
  overrides: Partial<VolunteerMatch> = {},
): VolunteerMatch {
  return {
    uid:          `vol-${Math.random().toString(36).slice(2)}`,
    displayName:  'Test Volunteer',
    phoneNumber:  '+919876543211',
    skills:       [VolunteerSkill.BOAT_OPERATOR],
    languages:    [Language.ENGLISH, Language.MALAYALAM],
    location:     { lat: 10.020, lng: 76.345 },
    scores:       createMockScoreBreakdown(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RawReportCluster (deduplication intermediate)
// ---------------------------------------------------------------------------

export function createMockRawReportCluster(
  overrides: Partial<RawReportCluster> = {},
): RawReportCluster {
  const report = createMockRawReport();
  return {
    reports:                  [report],
    centroidLat:              report.location.lat,
    centroidLng:              report.location.lng,
    deduplicationConfidence:  0.95,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DisasterEvent
// ---------------------------------------------------------------------------

export function createMockDisaster(
  overrides: Partial<DisasterEvent> = {},
): DisasterEvent {
  return {
    id:               `disaster-${Math.random().toString(36).slice(2)}`,
    name:             'Kerala Flood Alert — Ernakulam, Wayanad',
    type:             DisasterType.FLOOD,
    severity:         DisasterSeverity.CATASTROPHIC,
    status:           DisasterStatus.ACTIVE,
    phase:            DisasterPhase.RESPONSE,
    affectedDistricts: ['Ernakulam', 'Wayanad', 'Idukki'],
    affectedStates:   ['Kerala'],
    boundingBox:      { north: 11.0, south: 9.5, east: 77.5, west: 75.5 },
    activatedAt:      mockTimestamp(),
    activatedBy:      'SYSTEM_AUTO',
    resolvedAt:       null,
    resolvedBy:       null,
    officialUrl:      null,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { AssignmentStatus, DeclineReason, NeedType, NeedStatus, NeedSeverity, VolunteerSkill, Language };
