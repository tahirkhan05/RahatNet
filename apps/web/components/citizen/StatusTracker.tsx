'use client';

/**
 * StatusTracker — real-time view of a citizen's submitted reports.
 *
 * Subscribes to Firestore /rawReports where reporterId === uid.
 * Each report card shows the full status lifecycle with a visual stepper,
 * an estimated arrival time (when available), and a "Contact coordinator"
 * button that launches a phone call.
 *
 * The subscription is cleaned up on unmount so there are no listener leaks.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Clock,
  CheckCircle2,
  Loader2,
  Phone,
  MapPin,
  AlertCircle,
  Plus,
  RefreshCw,
  Navigation,
} from 'lucide-react';
import { NeedType, NeedStatus } from '@rahatnet/types';
import type { RawReport } from '@rahatnet/types';
import { t } from '@/lib/i18n/t';
import { COLLECTIONS } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Status display config
// ---------------------------------------------------------------------------

type DisplayStatus =
  | 'PENDING'
  | 'AI_PROCESSING'
  | 'VERIFIED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'DUPLICATE'
  | 'CANCELLED';

interface StatusConfig {
  label: string;
  color: string;
  bgColor: string;
  icon: React.ReactNode;
  step: number; // 0-indexed for the stepper
}

const STATUS_CONFIG: Record<DisplayStatus, StatusConfig> = {
  PENDING:        { label: t('status.status.PENDING'),    color: 'text-blue-600',   bgColor: 'bg-blue-50 dark:bg-blue-950',   icon: <Clock className="h-4 w-4" />,        step: 0 },
  AI_PROCESSING:  { label: t('status.status.AI_PROCESSING'), color: 'text-purple-600', bgColor: 'bg-purple-50 dark:bg-purple-950', icon: <Loader2 className="h-4 w-4 animate-spin" />, step: 1 },
  VERIFIED:       { label: t('status.status.VERIFIED'),   color: 'text-amber-600',  bgColor: 'bg-amber-50 dark:bg-amber-950', icon: <CheckCircle2 className="h-4 w-4" />, step: 2 },
  ASSIGNED:       { label: t('status.status.ASSIGNED'),   color: 'text-primary',    bgColor: 'bg-primary/10',                  icon: <CheckCircle2 className="h-4 w-4" />, step: 3 },
  IN_PROGRESS:    { label: t('status.status.IN_PROGRESS'), color: 'text-green-600',  bgColor: 'bg-green-50 dark:bg-green-950', icon: <CheckCircle2 className="h-4 w-4" />, step: 4 },
  RESOLVED:       { label: t('status.status.RESOLVED'),   color: 'text-green-700',  bgColor: 'bg-green-50 dark:bg-green-950', icon: <CheckCircle2 className="h-4 w-4 fill-current" />, step: 5 },
  DUPLICATE:      { label: t('status.status.DUPLICATE'),  color: 'text-muted-foreground', bgColor: 'bg-secondary', icon: <RefreshCw className="h-4 w-4" />, step: -1 },
  CANCELLED:      { label: t('status.status.CANCELLED'),  color: 'text-destructive', bgColor: 'bg-destructive/10', icon: <AlertCircle className="h-4 w-4" />, step: -1 },
};

const STEPPER_LABELS = [
  t('status.status.PENDING'),
  t('status.status.AI_PROCESSING'),
  t('status.status.VERIFIED'),
  t('status.status.ASSIGNED'),
  t('status.status.IN_PROGRESS'),
  t('status.status.RESOLVED'),
];

const NEED_TYPE_LABELS: Record<NeedType, string> = {
  [NeedType.RESCUE]:        'Rescue',
  [NeedType.FOOD]:          'Food & Water',
  [NeedType.MEDICINE]:      'Medicine',
  [NeedType.SHELTER]:       'Shelter',
  [NeedType.MENTAL_HEALTH]: 'Mental Support',
  [NeedType.INFRASTRUCTURE]:'Infrastructure',
};

const COORDINATOR_PHONE = process.env['NEXT_PUBLIC_COORDINATOR_PHONE'] ?? '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(timestamp: number): string {
  const diffSecs = Math.floor((Date.now() - timestamp) / 1_000);
  if (diffSecs < 60) return 'Just now';
  if (diffSecs < 3_600) return `${Math.floor(diffSecs / 60)} min ago`;
  if (diffSecs < 86_400) return `${Math.floor(diffSecs / 3_600)} hr ago`;
  return `${Math.floor(diffSecs / 86_400)} day(s) ago`;
}

// ---------------------------------------------------------------------------
// Status Stepper
// ---------------------------------------------------------------------------

function StatusStepper({ currentStep }: { currentStep: number }) {
  if (currentStep < 0) return null; // Duplicate / Cancelled don't show a stepper.

  return (
    <div className="flex items-center" aria-label="Status progress">
      {STEPPER_LABELS.map((label, i) => {
        const isPast = i < currentStep;
        const isCurrent = i === currentStep;

        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center gap-1">
              <div
                className={[
                  'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition-colors',
                  isCurrent ? 'bg-primary text-primary-foreground' :
                  isPast    ? 'bg-primary/30 text-primary' :
                              'bg-secondary text-muted-foreground',
                ].join(' ')}
                aria-current={isCurrent ? 'step' : undefined}
                aria-label={label}
              >
                {isPast ? '✓' : i + 1}
              </div>
              <span
                className={[
                  'hidden text-[9px] font-medium sm:block max-w-[40px] text-center leading-tight',
                  isCurrent ? 'text-primary' : isPast ? 'text-muted-foreground' : 'text-muted-foreground/50',
                ].join(' ')}
              >
                {label}
              </span>
            </div>
            {i < STEPPER_LABELS.length - 1 && (
              <div
                className={[
                  'mx-0.5 h-0.5 flex-1 rounded-full transition-colors',
                  i < currentStep ? 'bg-primary/50' : 'bg-secondary',
                ].join(' ')}
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report card
// ---------------------------------------------------------------------------

interface ReportCardProps {
  report: RawReport;
}

interface VolunteerContact {
  displayName: string;
  phoneNumber: string | null;
  photoURL: string | null;
  volunteerId: string | null;
  lat: number | null;
  lng: number | null;
}

function useVolunteerContact(reportId: string, status: string): VolunteerContact | null {
  const [contact, setContact] = React.useState<VolunteerContact | null>(null);

  React.useEffect(() => {
    if (status !== 'ASSIGNED' && status !== 'IN_PROGRESS') return;
    let locationUnsub: (() => void) | undefined;

    void (async () => {
      try {
        const { collection, query, where, getDocs, doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const db = getFirestore(firebaseApp);
        const needsSnap = await getDocs(query(
          collection(db, 'needs'),
          where('rawReportIds', 'array-contains', reportId),
        ));
        if (needsSnap.empty) return;
        const need = needsSnap.docs[0]?.data();
        const volunteerId = need?.['assignedVolunteerId'] as string | undefined;
        if (!volunteerId) return;

        const volSnap = await getDoc(doc(db, 'users', volunteerId));
        if (!volSnap.exists()) return;
        const v = volSnap.data();
        setContact({
          displayName: v['displayName'] ?? 'Volunteer',
          phoneNumber: v['phoneNumber'] ?? null,
          photoURL: v['photoURL'] ?? null,
          volunteerId,
          lat: null,
          lng: null,
        });

        // Subscribe to RTDB live location
        const { getDatabase, ref, onValue } = await import('firebase/database');
        const { firebaseApp: app } = await import('@/lib/firebase/client');
        const rtdb = getDatabase(app);
        const locRef = ref(rtdb, `volunteerLocations/${volunteerId}`);
        locationUnsub = onValue(locRef, (snap) => {
          const loc = snap.val() as { lat?: number; lng?: number } | null;
          if (loc?.lat && loc?.lng) {
            setContact((prev) => prev ? { ...prev, lat: loc.lat!, lng: loc.lng! } : prev);
          }
        });
      } catch { /* silent */ }
    })();

    return () => { if (typeof locationUnsub === 'function') locationUnsub(); };
  }, [reportId, status]);

  return contact;
}

function useNeedStatus(reportId: string): { status: string; needId: string } | null {
  const [needInfo, setNeedInfo] = React.useState<{ status: string; needId: string } | null>(null);
  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, onSnapshot, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      const q = query(collection(db, 'needs'), where('rawReportIds', 'array-contains', reportId));
      unsub = onSnapshot(q, (snap) => {
        if (!snap.empty) {
          const d = snap.docs[0]?.data();
          setNeedInfo({ status: d?.['status'] ?? 'VERIFIED', needId: snap.docs[0]?.id ?? '' });
        }
      });
    })();
    return () => unsub?.();
  }, [reportId]);
  return needInfo;
}

function ReportCard({ report }: ReportCardProps) {
  const rawReportStatus = report.status as string;
  const needInfo = useNeedStatus(report.id);
  // Use need status if available (more accurate), else fall back to rawReport status
  const effectiveStatus = needInfo?.status ?? rawReportStatus;
  const rawStatus = effectiveStatus as DisplayStatus;
  const config = STATUS_CONFIG[rawStatus] ?? STATUS_CONFIG[rawReportStatus as DisplayStatus] ?? STATUS_CONFIG['PENDING'];
  const volunteerContact = useVolunteerContact(report.id, rawStatus);

  // Approximate timestamp from queuedAt (Firestore Timestamp or number).
  const ts =
    typeof report.createdAt === 'object' && 'seconds' in report.createdAt
      ? (report.createdAt as { seconds: number }).seconds * 1000
      : Date.now();

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${config.bgColor} ${config.color}`}>
            {config.icon}
            {config.label}
          </span>
          <span className="text-sm font-medium text-foreground">
            {NEED_TYPE_LABELS[report.type] ?? report.type}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{relativeTime(ts)}</span>
      </div>

      {/* Stepper */}
      <div className="border-b border-border px-4 py-3">
        <StatusStepper currentStep={config.step} />
      </div>

      {/* Details */}
      <div className="space-y-2 px-4 py-3">
        {/* Location */}
        <div className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="line-clamp-1">{report.locationName}</span>
        </div>

        {/* Description preview */}
        {report.description.length > 0 && (
          <p className="line-clamp-2 text-sm text-foreground">{report.description}</p>
        )}

        {/* People count */}
        <p className="text-xs text-muted-foreground">
          {t('status.people', { count: report.affectedCount })}
          {report.hasVulnerable && ' · includes elderly/child/disabled'}
        </p>
      </div>

      {/* Contact info (shown when help is assigned/in progress) */}
      {(rawStatus === 'ASSIGNED' || rawStatus === 'IN_PROGRESS') && (
        <div className="border-t border-border px-4 py-3 space-y-2">
          {volunteerContact ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                {volunteerContact.photoURL ? (
                  <img src={volunteerContact.photoURL} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {volunteerContact.displayName[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{volunteerContact.displayName}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    Your volunteer
                    {volunteerContact.lat && (
                      <span className="text-green-500">• Live location available</span>
                    )}
                  </p>
                </div>
                {volunteerContact.phoneNumber && (
                  <a href={`tel:${volunteerContact.phoneNumber}`}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                    <Phone className="h-4 w-4" /> Call
                  </a>
                )}
              </div>
              {volunteerContact.volunteerId && needInfo?.needId && (
                <Link
                  href={`/citizen/track?volunteerId=${volunteerContact.volunteerId}&needId=${needInfo.needId}`}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  <Navigation className="h-4 w-4" />
                  {volunteerContact.lat ? 'Track live location' : 'View volunteer on map'}
                </Link>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Help is on the way…</p>
          )}
          {COORDINATOR_PHONE !== '' && (
            <a href={`tel:${COORDINATOR_PHONE}`}
              className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-accent">
              <Phone className="h-3.5 w-3.5" /> Emergency: Call Coordinator
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main StatusTracker
// ---------------------------------------------------------------------------

interface StatusTrackerProps {
  userId: string;
}

export function StatusTracker({ userId }: StatusTrackerProps) {
  const router = useRouter();
  const [reports, setReports] = React.useState<RawReport[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { subscribeToDocuments } = await import('@/lib/firebase/firestore');
        const { where, orderBy, limit } = await import('firebase/firestore');

        unsubscribe = subscribeToDocuments<RawReport>(
          COLLECTIONS.RAW_REPORTS,
          (docs) => {
            setReports(docs);
            setLoading(false);
          },
          undefined,
          where('reporterId', '==', userId),
          orderBy('createdAt', 'desc'),
          limit(20),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('common.error.generic');
        setError(msg);
        setLoading(false);
      }
    })();

    return () => unsubscribe?.();
  }, [userId]);

  // ---- Loading skeleton ----
  if (loading) {
    return (
      <div className="space-y-4" aria-label={t('status.loading')} role="status">
        {[1, 2].map((i) => (
          <div key={i} className="h-40 rounded-xl border border-border skeleton-shimmer" />
        ))}
        <span className="sr-only">{t('status.loading')}</span>
      </div>
    );
  }

  // ---- Error ----
  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      >
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {error}
      </div>
    );
  }

  // ---- Empty ----
  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Clock className="h-8 w-8" aria-hidden="true" />
        </div>
        <div>
          <p className="font-medium text-foreground">{t('status.empty')}</p>
        </div>
        <button
          type="button"
          onClick={() => router.push('/citizen/report')}
          className="flex min-h-[48px] items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('status.report_new')}
        </button>
      </div>
    );
  }

  // ---- Reports list ----
  return (
    <div className="space-y-4">
      {reports.map((report) => (
        <ReportCard key={report.id} report={report} />
      ))}
      <button
        type="button"
        onClick={() => router.push('/citizen/report')}
        className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('status.report_new')}
      </button>
    </div>
  );
}
