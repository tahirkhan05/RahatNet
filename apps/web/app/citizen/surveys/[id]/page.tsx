'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronLeft,
  MapPin,
  Clock,
  User,
  Building2,
  Loader2,
  ClipboardList,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface SurveyData {
  householdSize: number;
  landmark?: string;
  surveyorName: string;
  surveyorOrg?: string;
  hasDisability: boolean;
  disabilityNotes?: string;
  elderlyCount: number;
  childrenCount: number;
  hasPregnant: boolean;
  hasChronicIllness: boolean;
  hasNoFoodSecurity: boolean;
  isFloodRisk: boolean;
  hasCleanWater: boolean;
  severityEstimate: string;
  additionalNotes?: string;
}

interface SurveyDoc {
  id: string;
  type: string;
  status: string;
  description: string;
  locationName: string;
  affectedCount: number;
  hasVulnerable: boolean;
  createdAt: number;
  surveyData?: SurveyData;
}

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  URGENT: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  NORMAL: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  LOW: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const NEED_LABELS: Record<string, string> = {
  RESCUE: 'Rescue / Evacuation',
  FOOD: 'Food / Water',
  MEDICINE: 'Medicine / Medical',
  SHELTER: 'Shelter',
  MENTAL_HEALTH: 'Mental Health',
  INFRASTRUCTURE: 'Infrastructure',
};

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="text-muted-foreground w-40 shrink-0 text-sm">{label}</span>
      <span
        className={`text-right text-sm font-medium ${highlight ? 'text-destructive' : 'text-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="border-border bg-secondary/30 border-b px-4 py-2.5">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {title}
        </p>
      </div>
      <div className="divide-border divide-y px-4">{children}</div>
    </div>
  );
}

export default function SurveyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const [survey, setSurvey] = React.useState<SurveyDoc | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notFound, setNotFound] = React.useState(false);

  React.useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
  }, [authLoading, isAuthenticated, router]);

  React.useEffect(() => {
    if (!user?.uid || !id) return;

    void (async () => {
      try {
        const { getFirestore, doc, getDoc } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const db = getFirestore(firebaseApp);
        const snap = await getDoc(doc(db, 'rawReports', id));

        if (!snap.exists()) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        const data = snap.data();
        // Security: only the submitter can view their own survey
        if (data['reporterId'] !== user.uid) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        setSurvey({
          id: snap.id,
          type: (data['type'] as string) ?? 'FOOD',
          status: (data['status'] as string) ?? 'PENDING',
          description: (data['description'] as string) ?? '',
          locationName: (data['locationName'] as string) ?? '',
          affectedCount: (data['affectedCount'] as number) ?? 1,
          hasVulnerable: (data['hasVulnerable'] as boolean) ?? false,
          createdAt: (data['createdAt']?.toMillis?.() ?? Date.now()) as number,
          surveyData: data['surveyData'] as SurveyData | undefined,
        });
        setLoading(false);
      } catch {
        setLoading(false);
        setNotFound(true);
      }
    })();
  }, [user?.uid, id]);

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (notFound || !survey) {
    return (
      <div className="space-y-4 py-10 text-center">
        <p className="text-muted-foreground">Survey not found.</p>
        <Link href="/citizen/surveys" className="text-primary text-sm hover:underline">
          Back to surveys
        </Link>
      </div>
    );
  }

  const sd = survey.surveyData;
  const statusLabel =
    survey.status === 'PENDING'
      ? 'Submitted'
      : survey.status === 'PROCESSED'
        ? 'Mapped to war room'
        : survey.status;
  const severityColor =
    SEVERITY_COLORS[sd?.severityEstimate ?? 'NORMAL'] ?? SEVERITY_COLORS['NORMAL'];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/citizen/surveys"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1 rounded-lg p-1.5"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-foreground flex items-center gap-2 truncate text-xl font-semibold">
            <ClipboardList className="text-muted-foreground h-5 w-5 shrink-0" />
            {NEED_LABELS[survey.type] ?? survey.type} Survey
          </h1>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                survey.status === 'PENDING'
                  ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                  : survey.status === 'PROCESSED'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {statusLabel}
            </span>
            {sd?.severityEstimate && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColor}`}
              >
                {sd.severityEstimate.charAt(0) + sd.severityEstimate.slice(1).toLowerCase()}{' '}
                priority
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Location */}
      <div className="border-border bg-card flex items-start gap-2 rounded-xl border px-4 py-3">
        <MapPin className="text-primary mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-foreground text-sm font-medium">{survey.locationName}</p>
          {sd?.landmark && <p className="text-muted-foreground mt-0.5 text-xs">{sd.landmark}</p>}
        </div>
        <div className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1 text-xs">
          <Clock className="h-3 w-3" />
          {new Date(survey.createdAt).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </div>
      </div>

      {/* Household */}
      <Section title="Household">
        <Row label="People in household" value={sd?.householdSize ?? survey.affectedCount} />
        <Row label="Primary need" value={NEED_LABELS[survey.type] ?? survey.type} />
        <Row
          label="Vulnerable members"
          value={
            survey.hasVulnerable ? (
              <span className="flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                Yes
              </span>
            ) : (
              'No'
            )
          }
          highlight={survey.hasVulnerable}
        />
      </Section>

      {/* Vulnerability flags */}
      {sd && (
        <Section title="Vulnerability assessment">
          <Row
            label="Disability"
            value={
              sd.hasDisability ? `Yes${sd.disabilityNotes ? ' — ' + sd.disabilityNotes : ''}` : 'No'
            }
            highlight={sd.hasDisability}
          />
          <Row
            label="Elderly (60+)"
            value={
              sd.elderlyCount > 0
                ? `${sd.elderlyCount} person${sd.elderlyCount > 1 ? 's' : ''}`
                : 'None'
            }
            highlight={sd.elderlyCount > 0}
          />
          <Row
            label="Children under 12"
            value={
              sd.childrenCount > 0
                ? `${sd.childrenCount} child${sd.childrenCount > 1 ? 'ren' : ''}`
                : 'None'
            }
            highlight={sd.childrenCount > 0}
          />
          <Row
            label="Pregnant"
            value={
              sd.hasPregnant ? (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Yes
                </span>
              ) : (
                'No'
              )
            }
            highlight={sd.hasPregnant}
          />
          <Row
            label="Chronic illness"
            value={
              sd.hasChronicIllness ? (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Yes
                </span>
              ) : (
                'No'
              )
            }
            highlight={sd.hasChronicIllness}
          />
          <Row
            label="Food security"
            value={
              sd.hasNoFoodSecurity ? (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  At risk
                </span>
              ) : (
                'Secure'
              )
            }
            highlight={sd.hasNoFoodSecurity}
          />
          <Row
            label="Flood risk zone"
            value={
              sd.isFloodRisk ? (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Yes
                </span>
              ) : (
                'No'
              )
            }
            highlight={sd.isFloodRisk}
          />
          <Row
            label="Clean water access"
            value={
              sd.hasCleanWater ? (
                'Yes'
              ) : (
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  No
                </span>
              )
            }
            highlight={!sd.hasCleanWater}
          />
        </Section>
      )}

      {/* Surveyor */}
      {sd && (
        <Section title="Surveyor">
          <Row
            label="Name"
            value={
              <span className="flex items-center gap-1.5">
                <User className="text-muted-foreground h-3.5 w-3.5" />
                {sd.surveyorName}
              </span>
            }
          />
          {sd.surveyorOrg && (
            <Row
              label="Organisation"
              value={
                <span className="flex items-center gap-1.5">
                  <Building2 className="text-muted-foreground h-3.5 w-3.5" />
                  {sd.surveyorOrg}
                </span>
              }
            />
          )}
        </Section>
      )}

      {/* Additional notes */}
      {sd?.additionalNotes && (
        <Section title="Additional notes">
          <div className="text-foreground py-3 text-sm leading-relaxed">{sd.additionalNotes}</div>
        </Section>
      )}

      {/* Fallback if surveyData missing (old submission) */}
      {!sd && (
        <Section title="Survey notes">
          <div className="text-foreground py-3 text-sm leading-relaxed">{survey.description}</div>
        </Section>
      )}
    </div>
  );
}
