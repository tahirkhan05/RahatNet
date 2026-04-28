'use client';

/**
 * SurveyReportForm — structured community survey for NGO field workers.
 *
 * Designed for pre-disaster vulnerability mapping, not panic reporting.
 * Field workers walk door-to-door and fill this out per household.
 *
 * Step 1: Household info (size, location, landmark, surveyor org)
 * Step 2: Vulnerability flags (disability, elderly, children, food security, flood risk)
 * Step 3: Need classification + confirm (same NeedType enum → same AI pipeline)
 *
 * Submits to /api/needs with source: 'SURVEY'.
 * The AI pipeline processes it identically — it appears on the war room map
 * as a grey pre-mapped vulnerability pin (distinct from crisis red pins).
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Send,
  MapPin,
  MapPinOff,
  Pencil,
  Loader2,
  AlertCircle,
  Anchor,
  UtensilsCrossed,
  Cross,
  Home,
  Heart,
  Building2,
  Minus,
  Plus,
  CheckSquare,
} from 'lucide-react';
import { NeedType, NeedSeverity } from '@rahatnet/types';
import { useOffline } from '@/hooks/useOffline';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useGeolocation } from '@/hooks/useGeolocation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3;

interface SurveyState {
  // Step 1 — Household info
  householdSize: number;
  locationName: string;
  locationOverride: string;
  isEditingLocation: boolean;
  gpsLat: number | null;
  gpsLng: number | null;
  landmark: string;
  surveyorName: string;
  surveyorOrg: string;

  // Step 2 — Vulnerability flags
  hasDisability: boolean;
  disabilityNotes: string;
  elderlyCount: number;
  childrenCount: number;
  hasPregnant: boolean;
  hasChronicIllness: boolean;
  hasNoFoodSecurity: boolean;
  isFloodRisk: boolean;
  hasCleanWater: boolean;

  // Step 3 — Need classification
  needType: NeedType | null;
  severityEstimate: NeedSeverity;
  additionalNotes: string;
}

interface SurveyReportFormProps {
  userId: string;
  onSuccess: (reportId: string, wasQueued: boolean) => void;
}

// ---------------------------------------------------------------------------
// Need type catalogue (same as NeedReportForm)
// ---------------------------------------------------------------------------

const NEED_TYPES: Array<{ type: NeedType; icon: React.ReactNode; color: string }> = [
  {
    type: NeedType.RESCUE,
    icon: <Anchor className="h-6 w-6" />,
    color: 'text-red-600 bg-red-50 dark:bg-red-950',
  },
  {
    type: NeedType.FOOD,
    icon: <UtensilsCrossed className="h-6 w-6" />,
    color: 'text-amber-600 bg-amber-50 dark:bg-amber-950',
  },
  {
    type: NeedType.MEDICINE,
    icon: <Cross className="h-6 w-6" />,
    color: 'text-blue-600 bg-blue-50 dark:bg-blue-950',
  },
  {
    type: NeedType.SHELTER,
    icon: <Home className="h-6 w-6" />,
    color: 'text-green-600 bg-green-50 dark:bg-green-950',
  },
  {
    type: NeedType.MENTAL_HEALTH,
    icon: <Heart className="h-6 w-6" />,
    color: 'text-purple-600 bg-purple-50 dark:bg-purple-950',
  },
  {
    type: NeedType.INFRASTRUCTURE,
    icon: <Building2 className="h-6 w-6" />,
    color: 'text-orange-600 bg-orange-50 dark:bg-orange-950',
  },
];

const NEED_LABELS: Record<NeedType, string> = {
  RESCUE: 'Rescue / Evacuation',
  FOOD: 'Food / Water',
  MEDICINE: 'Medicine / Medical',
  SHELTER: 'Shelter',
  MENTAL_HEALTH: 'Mental Health',
  INFRASTRUCTURE: 'Infrastructure',
};

const SEVERITY_LABELS: Record<NeedSeverity, { label: string; desc: string; color: string }> = {
  CRITICAL: {
    label: 'Critical',
    desc: 'Immediate threat to life',
    color: 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  URGENT: {
    label: 'Urgent',
    desc: 'Needs response within 1 hour',
    color: 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  NORMAL: {
    label: 'Moderate',
    desc: 'Needs response within 4 hours',
    color: 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  LOW: {
    label: 'Low',
    desc: 'Non-urgent, can wait for next cycle',
    color: 'border-gray-400 bg-gray-50 text-gray-700 dark:bg-gray-950 dark:text-gray-300',
  },
};

// ---------------------------------------------------------------------------
// Shared stepper (reuse pattern from NeedReportForm)
// ---------------------------------------------------------------------------

function CountStepper({
  value,
  onChange,
  min = 0,
  max = 100,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label={`Decrease ${label}`}
        className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex h-10 w-10 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2"
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="min-w-[3ch] text-center text-lg font-semibold" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label={`Increase ${label}`}
        className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex h-10 w-10 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function FlagRow({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="border-border bg-card flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="border-border accent-primary focus-visible:ring-ring h-5 w-5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
          aria-label={label}
        />
        <span className="text-foreground text-sm">{label}</span>
      </label>
      {checked && children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Household info
// ---------------------------------------------------------------------------

function Step1({
  state,
  update,
  onNext,
}: {
  state: SurveyState;
  update: (p: Partial<SurveyState>) => void;
  onNext: () => void;
}) {
  const { lat, lng, error: geoError, isLoading: geoLoading } = useGeolocation();
  const [geocoding, setGeocoding] = React.useState(false);

  React.useEffect(() => {
    if (lat == null || lng == null) return;
    update({ gpsLat: lat, gpsLng: lng });
    setGeocoding(true);
    const key = process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'];
    if (!key) {
      update({ locationName: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      setGeocoding(false);
      return;
    }
    fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`)
      .then((r) => r.json())
      .then((data: { results?: Array<{ formatted_address?: string }> }) => {
        const name = data.results?.[0]?.formatted_address ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        update({ locationName: name });
      })
      .catch(() => update({ locationName: `${lat.toFixed(4)}, ${lng.toFixed(4)}` }))
      .finally(() => setGeocoding(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  const canProceed =
    state.householdSize >= 1 &&
    (state.locationName || state.locationOverride) &&
    state.surveyorName.trim().length > 0;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Household information</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Record the details of the household you are surveying.
        </p>
      </div>

      {/* Household size */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">Number of people in household</p>
        <CountStepper
          value={state.householdSize}
          onChange={(n) => update({ householdSize: n })}
          min={1}
          max={50}
          label="household size"
        />
      </div>

      {/* Location */}
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Household location</p>
        {geoLoading || geocoding ? (
          <div className="border-border bg-secondary text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            Detecting location…
          </div>
        ) : state.isEditingLocation ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={state.locationOverride}
              onChange={(e) => update({ locationOverride: e.target.value })}
              placeholder="Enter address or area name"
              className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring flex-1 rounded-lg border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
            />
            <button
              type="button"
              onClick={() =>
                update({
                  locationName: state.locationOverride || state.locationName,
                  isEditingLocation: false,
                })
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2"
            >
              Save
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="border-border bg-secondary/50 flex flex-1 items-start gap-2 rounded-lg border px-3 py-2.5">
              {geoError != null ? (
                <MapPinOff className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <MapPin className="text-primary mt-0.5 h-4 w-4 shrink-0" />
              )}
              <p className="text-foreground line-clamp-2 text-sm">
                {state.locationName ||
                  (geoError != null ? 'Location unavailable — enter manually' : '…')}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                update({ isEditingLocation: true, locationOverride: state.locationName })
              }
              aria-label="Edit location"
              className="border-border bg-background text-muted-foreground hover:bg-accent focus-visible:ring-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Landmark */}
      <div className="space-y-1.5">
        <label htmlFor="landmark" className="text-foreground block text-sm font-medium">
          Landmark or additional address detail{' '}
          <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          id="landmark"
          type="text"
          value={state.landmark}
          onChange={(e) => update({ landmark: e.target.value })}
          placeholder="e.g. Near the old temple, House No. 14"
          className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-xl border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </div>

      {/* Surveyor info */}
      <div className="border-border bg-secondary/30 space-y-3 rounded-xl border p-4">
        <p className="text-foreground text-sm font-medium">Surveyor details</p>
        <div className="space-y-1.5">
          <label htmlFor="surveyorName" className="text-muted-foreground block text-xs">
            Your name
          </label>
          <input
            id="surveyorName"
            type="text"
            value={state.surveyorName}
            onChange={(e) => update({ surveyorName: e.target.value })}
            placeholder="Full name"
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="surveyorOrg" className="text-muted-foreground block text-xs">
            Organisation / NGO <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            id="surveyorOrg"
            type="text"
            value={state.surveyorOrg}
            onChange={(e) => update({ surveyorOrg: e.target.value })}
            placeholder="e.g. Kerala Voluntary Health Association"
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!canProceed}
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Next
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Vulnerability flags
// ---------------------------------------------------------------------------

function Step2({
  state,
  update,
  onBack,
  onNext,
}: {
  state: SurveyState;
  update: (p: Partial<SurveyState>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Vulnerability assessment</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Check all that apply to this household.
        </p>
      </div>

      {/* Disability */}
      <FlagRow
        checked={state.hasDisability}
        onChange={(v) => update({ hasDisability: v })}
        label="Someone in this household has a disability"
      >
        <input
          type="text"
          value={state.disabilityNotes}
          onChange={(e) => update({ disabilityNotes: e.target.value })}
          placeholder="Describe the disability (e.g. mobility impairment, visually impaired)"
          className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </FlagRow>

      {/* Elderly */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">Number of elderly people (60+)</p>
        <CountStepper
          value={state.elderlyCount}
          onChange={(n) => update({ elderlyCount: n })}
          min={0}
          max={20}
          label="elderly count"
        />
      </div>

      {/* Children */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">Number of children under 12</p>
        <CountStepper
          value={state.childrenCount}
          onChange={(n) => update({ childrenCount: n })}
          min={0}
          max={20}
          label="children count"
        />
      </div>

      {/* Pregnant */}
      <FlagRow
        checked={state.hasPregnant}
        onChange={(v) => update({ hasPregnant: v })}
        label="Pregnant woman in household"
      />

      {/* Chronic illness */}
      <FlagRow
        checked={state.hasChronicIllness}
        onChange={(v) => update({ hasChronicIllness: v })}
        label="Someone requires regular medicine or medical care"
      />

      {/* Food security */}
      <FlagRow
        checked={state.hasNoFoodSecurity}
        onChange={(v) => update({ hasNoFoodSecurity: v })}
        label="Household does not have food security (at risk of hunger)"
      />

      {/* Flood risk */}
      <FlagRow
        checked={state.isFloodRisk}
        onChange={(v) => update({ isFloodRisk: v })}
        label="This location is in a known flood-risk area"
      />

      {/* Water access */}
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">Access to clean drinking water</p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => update({ hasCleanWater: true })}
            aria-pressed={state.hasCleanWater}
            className={[
              'focus-visible:ring-ring flex-1 rounded-xl border py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
              state.hasCleanWater
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-border bg-background text-foreground hover:bg-accent',
            ].join(' ')}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => update({ hasCleanWater: false })}
            aria-pressed={!state.hasCleanWater}
            className={[
              'focus-visible:ring-ring flex-1 rounded-xl border py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2',
              !state.hasCleanWater
                ? 'border-destructive bg-destructive/5 text-destructive'
                : 'border-border bg-background text-foreground hover:bg-accent',
            ].join(' ')}
          >
            No
          </button>
        </div>
      </div>

      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex min-h-[48px] items-center gap-1.5 rounded-xl border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          Next
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Need classification + confirm
// ---------------------------------------------------------------------------

function Step3({
  state,
  update,
  onBack,
  onSubmit,
  submitting,
  isOnline,
}: {
  state: SurveyState;
  update: (p: Partial<SurveyState>) => void;
  onBack: () => void;
  onSubmit: () => Promise<void>;
  submitting: boolean;
  isOnline: boolean;
}) {
  const vulnerabilities: string[] = [];
  if (state.hasDisability) vulnerabilities.push('Disability');
  if (state.elderlyCount > 0) vulnerabilities.push(`${state.elderlyCount} elderly`);
  if (state.childrenCount > 0) vulnerabilities.push(`${state.childrenCount} children`);
  if (state.hasPregnant) vulnerabilities.push('Pregnant');
  if (state.hasChronicIllness) vulnerabilities.push('Chronic illness');
  if (state.hasNoFoodSecurity) vulnerabilities.push('Food insecure');
  if (state.isFloodRisk) vulnerabilities.push('Flood risk zone');
  if (!state.hasCleanWater) vulnerabilities.push('No clean water');

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-foreground text-lg font-semibold">Primary need & confirm</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Select the most urgent need and review before submitting.
        </p>
      </div>

      {/* Need type selector */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">
          Primary need type <span className="text-destructive">*</span>
        </p>
        <div className="grid grid-cols-2 gap-2">
          {NEED_TYPES.map(({ type, icon, color }) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={state.needType === type}
              onClick={() => update({ needType: type })}
              className={[
                'flex min-h-[60px] flex-col items-center justify-center gap-1.5 rounded-xl border p-3 text-center transition-all',
                'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
                state.needType === type
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-accent',
              ].join(' ')}
            >
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${color}`}>
                {icon}
              </div>
              <span
                className={`text-xs font-medium ${state.needType === type ? 'text-primary' : 'text-foreground'}`}
              >
                {NEED_LABELS[type]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Severity estimate */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">
          Urgency estimate (your field assessment)
        </p>
        <div className="space-y-2">
          {(Object.keys(SEVERITY_LABELS) as NeedSeverity[]).map((sev) => {
            const cfg = SEVERITY_LABELS[sev];
            return (
              <button
                key={sev}
                type="button"
                role="radio"
                aria-checked={state.severityEstimate === sev}
                onClick={() => update({ severityEstimate: sev })}
                className={[
                  'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all',
                  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
                  state.severityEstimate === sev
                    ? cfg.color + ' shadow-sm'
                    : 'border-border bg-background hover:bg-accent',
                ].join(' ')}
              >
                <CheckSquare
                  className={`h-4 w-4 shrink-0 ${state.severityEstimate === sev ? '' : 'text-muted-foreground'}`}
                />
                <div>
                  <p className="text-sm font-medium">{cfg.label}</p>
                  <p className="text-muted-foreground text-xs">{cfg.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Additional notes */}
      <div className="space-y-1.5">
        <label htmlFor="surveyNotes" className="text-foreground block text-sm font-medium">
          Additional notes <span className="text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="surveyNotes"
          value={state.additionalNotes}
          onChange={(e) => update({ additionalNotes: e.target.value })}
          placeholder="Any other relevant details about this household's situation"
          rows={3}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-none rounded-xl border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </div>

      {/* Summary card */}
      <div className="divide-border border-border bg-card divide-y rounded-xl border text-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span className="text-foreground line-clamp-1">
            {state.locationName || state.locationOverride}
          </span>
        </div>
        <div className="text-muted-foreground px-4 py-3">
          {state.householdSize} people · {state.surveyorName}
          {state.surveyorOrg ? ` · ${state.surveyorOrg}` : ''}
        </div>
        {vulnerabilities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 py-3">
            {vulnerabilities.map((v) => (
              <span
                key={v}
                className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              >
                {v}
              </span>
            ))}
          </div>
        )}
      </div>

      {!isOnline && (
        <p className="border-warning/30 bg-warning/5 text-foreground rounded-lg border px-3 py-2.5 text-sm">
          You are offline. Your survey will be saved and submitted when reconnected.
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex min-h-[48px] items-center gap-1.5 rounded-xl border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || state.needType === null}
          aria-busy={submitting}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              Submitting…
            </>
          ) : (
            <>
              <Send className="h-5 w-5" aria-hidden="true" />
              Submit survey
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step} of 3`} role="status">
      {([1, 2, 3] as Step[]).map((s) => (
        <div
          key={s}
          aria-current={step === s ? 'step' : undefined}
          className={[
            'h-1.5 rounded-full transition-all duration-300',
            s === step ? 'bg-primary w-8' : s < step ? 'bg-primary/50 w-4' : 'bg-secondary w-4',
          ].join(' ')}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

const ACTIVE_DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'demo-disaster-001';

export function SurveyReportForm({ userId, onSuccess }: SurveyReportFormProps) {
  const [step, setStep] = React.useState<Step>(1);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const { isOnline } = useOffline();
  const { enqueue } = useOfflineQueue((id) => {
    void id;
  });

  const [form, setForm] = React.useState<SurveyState>({
    householdSize: 1,
    locationName: '',
    locationOverride: '',
    isEditingLocation: false,
    gpsLat: null,
    gpsLng: null,
    landmark: '',
    surveyorName: '',
    surveyorOrg: '',
    hasDisability: false,
    disabilityNotes: '',
    elderlyCount: 0,
    childrenCount: 0,
    hasPregnant: false,
    hasChronicIllness: false,
    hasNoFoodSecurity: false,
    isFloodRisk: false,
    hasCleanWater: true,
    needType: null,
    severityEstimate: NeedSeverity.NORMAL,
    additionalNotes: '',
  });

  const update = (patch: Partial<SurveyState>) => setForm((prev) => ({ ...prev, ...patch }));

  // Build a description string from survey flags for the AI pipeline
  const buildDescription = (): string => {
    const parts: string[] = [];
    parts.push(
      `Household of ${form.householdSize} people at ${form.locationName || form.locationOverride}.`,
    );
    if (form.landmark) parts.push(`Landmark: ${form.landmark}.`);
    if (form.hasDisability)
      parts.push(`Disability present${form.disabilityNotes ? ': ' + form.disabilityNotes : ''}.`);
    if (form.elderlyCount > 0) parts.push(`${form.elderlyCount} elderly person(s).`);
    if (form.childrenCount > 0) parts.push(`${form.childrenCount} children under 12.`);
    if (form.hasPregnant) parts.push('Pregnant woman present.');
    if (form.hasChronicIllness) parts.push('Requires regular medication/medical care.');
    if (form.hasNoFoodSecurity) parts.push('Household lacks food security.');
    if (form.isFloodRisk) parts.push('Located in flood-risk area.');
    if (!form.hasCleanWater) parts.push('No access to clean drinking water.');
    if (form.additionalNotes) parts.push(form.additionalNotes);
    parts.push(
      `Surveyed by: ${form.surveyorName}${form.surveyorOrg ? ' (' + form.surveyorOrg + ')' : ''}.`,
    );
    return parts.join(' ');
  };

  const handleSubmit = async () => {
    if (form.needType === null) return;
    setSubmitting(true);
    setSubmitError(null);

    const reportId = crypto.randomUUID();
    const locationName =
      form.isEditingLocation && form.locationOverride.trim().length > 0
        ? form.locationOverride
        : form.locationName ||
          (form.gpsLat != null && form.gpsLng != null
            ? `${form.gpsLat.toFixed(5)}, ${form.gpsLng.toFixed(5)}`
            : '');
    const description = buildDescription();

    const hasVulnerable =
      form.hasDisability ||
      form.elderlyCount > 0 ||
      form.childrenCount > 0 ||
      form.hasPregnant ||
      form.hasChronicIllness;

    const payload = {
      type: form.needType,
      description,
      originalDescription: description,
      originalLanguage: 'en',
      voiceNoteUrl: null,
      photoUrls: [] as string[],
      location: { lat: form.gpsLat ?? 0, lng: form.gpsLng ?? 0 },
      locationName,
      affectedCount: form.householdSize,
      hasVulnerable,
      disasterEventId: ACTIVE_DISASTER_ID,
      source: 'SURVEY' as const,
      surveyData: {
        householdSize: form.householdSize,
        landmark: form.landmark || undefined,
        surveyorName: form.surveyorName,
        surveyorOrg: form.surveyorOrg || undefined,
        hasDisability: form.hasDisability,
        disabilityNotes: form.disabilityNotes || undefined,
        elderlyCount: form.elderlyCount,
        childrenCount: form.childrenCount,
        hasPregnant: form.hasPregnant,
        hasChronicIllness: form.hasChronicIllness,
        hasNoFoodSecurity: form.hasNoFoodSecurity,
        isFloodRisk: form.isFloodRisk,
        hasCleanWater: form.hasCleanWater,
        severityEstimate: form.severityEstimate,
        additionalNotes: form.additionalNotes || undefined,
      },
    };

    if (!isOnline) {
      await enqueue({ id: reportId, ...payload });
      setSubmitting(false);
      onSuccess(reportId, true);
      return;
    }

    try {
      const res = await fetch('/api/needs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Failed to submit survey');
      }

      const data = (await res.json()) as { data?: { reportId?: string } };
      setSubmitting(false);
      onSuccess(data.data?.reportId ?? reportId, false);
    } catch (err) {
      if (!navigator.onLine) {
        await enqueue({ id: reportId, ...payload });
        setSubmitting(false);
        onSuccess(reportId, true);
        return;
      }
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit survey');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <StepIndicator step={step} />

      {step === 1 && <Step1 state={form} update={update} onNext={() => setStep(2)} />}
      {step === 2 && (
        <Step2 state={form} update={update} onBack={() => setStep(1)} onNext={() => setStep(3)} />
      )}
      {step === 3 && (
        <Step3
          state={form}
          update={update}
          onBack={() => setStep(2)}
          onSubmit={handleSubmit}
          submitting={submitting}
          isOnline={isOnline}
        />
      )}

      {submitError !== null && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {submitError}
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            className="focus-visible:ring-ring ml-auto rounded text-xs underline hover:no-underline focus-visible:outline-none focus-visible:ring-1"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
