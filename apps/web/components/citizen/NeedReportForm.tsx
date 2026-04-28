'use client';

/**
 * NeedReportForm — 3-step need reporting for citizens in a disaster.
 *
 * Step 1: Select need type (large tap-target cards)
 * Step 2: Describe — location, voice/text description, photo, count, vulnerability flag
 * Step 3: Confirm — summary review + submit (or queue offline)
 *
 * Design constraints for disaster context:
 *  - All tap targets ≥ 48 px (WCAG 2.5.5) — user may be in a moving boat.
 *  - Step 1 cards are 72 px tall — easy to hit with shaking hands.
 *  - Step transitions use a simple slide-fade (no heavy animations on low-end phones).
 *  - Every async operation has a loading state (no silent hangs on 2G).
 *  - Offline: automatically queued to IndexedDB, sent when reconnected.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Anchor,
  UtensilsCrossed,
  Cross,
  Home,
  Heart,
  Building2,
  MapPin,
  MapPinOff,
  Pencil,
  Users,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Send,
  WifiOff,
  Loader2,
  CheckCircle2,
  Minus,
  Plus,
  Mic,
  Camera,
  AlertTriangle,
} from 'lucide-react';
import { NeedType } from '@rahatnet/types';
import { t } from '@/lib/i18n/t';
import { useOffline } from '@/hooks/useOffline';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useGeolocation } from '@/hooks/useGeolocation';
import { VoiceRecorder } from './VoiceRecorder';
import { PhotoUploader } from './PhotoUploader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3;

interface FormState {
  type: NeedType | null;
  description: string;
  voiceBase64: string | null;
  photoUrl: string | null;
  affectedCount: number;
  hasVulnerable: boolean;
  locationName: string;
  locationOverride: string;
  isEditingLocation: boolean;
  gpsLat: number | null;
  gpsLng: number | null;
}

interface NeedReportFormProps {
  userId: string;
  /** Called on successful submit with the report ID (or queued ID if offline). */
  onSuccess: (reportId: string, wasQueued: boolean) => void;
}

// ---------------------------------------------------------------------------
// Need type catalogue
// ---------------------------------------------------------------------------

const NEED_TYPES: Array<{
  type: NeedType;
  icon: React.ReactNode;
  color: string;
}> = [
  {
    type: NeedType.RESCUE,
    icon: <Anchor className="h-7 w-7" />,
    color: 'text-red-600 bg-red-50 dark:bg-red-950',
  },
  {
    type: NeedType.FOOD,
    icon: <UtensilsCrossed className="h-7 w-7" />,
    color: 'text-amber-600 bg-amber-50 dark:bg-amber-950',
  },
  {
    type: NeedType.MEDICINE,
    icon: <Cross className="h-7 w-7" />,
    color: 'text-blue-600 bg-blue-50 dark:bg-blue-950',
  },
  {
    type: NeedType.SHELTER,
    icon: <Home className="h-7 w-7" />,
    color: 'text-green-600 bg-green-50 dark:bg-green-950',
  },
  {
    type: NeedType.MENTAL_HEALTH,
    icon: <Heart className="h-7 w-7" />,
    color: 'text-purple-600 bg-purple-50 dark:bg-purple-950',
  },
  {
    type: NeedType.INFRASTRUCTURE,
    icon: <Building2 className="h-7 w-7" />,
    color: 'text-orange-600 bg-orange-50 dark:bg-orange-950',
  },
];

// ---------------------------------------------------------------------------
// Step 1 — Need type selector
// ---------------------------------------------------------------------------

function NeedTypeCard({
  type,
  icon,
  color,
  selected,
  onSelect,
}: {
  type: NeedType;
  icon: React.ReactNode;
  color: string;
  selected: boolean;
  onSelect: (type: NeedType) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(type)}
      className={[
        'flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border p-3 text-center transition-all',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        selected
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-card hover:border-primary/40 hover:bg-accent',
      ].join(' ')}
    >
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}`}
        aria-hidden="true"
      >
        {icon}
      </div>
      <span className={`text-xs font-medium ${selected ? 'text-primary' : 'text-foreground'}`}>
        {t(`report.type.${type}` as Parameters<typeof t>[0])}
      </span>
    </button>
  );
}

function Step1({
  selected,
  onSelect,
  onNext,
}: {
  selected: NeedType | null;
  onSelect: (t: NeedType) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-foreground text-lg font-semibold">{t('report.step1.title')}</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">{t('report.step1.subtitle')}</p>
      </div>

      <div role="radiogroup" aria-label="Type of help needed" className="grid grid-cols-2 gap-3">
        {NEED_TYPES.map(({ type, icon, color }) => (
          <NeedTypeCard
            key={type}
            type={type}
            icon={icon}
            color={color}
            selected={selected === type}
            onSelect={onSelect}
          />
        ))}
      </div>

      {selected !== null && (
        <div className="bg-secondary/60 text-muted-foreground rounded-lg px-3 py-2 text-sm">
          <span className="text-foreground font-medium">
            {t(`report.type.${selected}` as Parameters<typeof t>[0])}
          </span>
          {' — '}
          {t(`report.type.${selected}.desc` as Parameters<typeof t>[0])}
        </div>
      )}

      <button
        type="button"
        onClick={onNext}
        disabled={selected === null}
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t('report.nav.next')}
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Description
// ---------------------------------------------------------------------------

function PeopleStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const isCustom = value > 9;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-pressed={value === n}
            className={[
              'flex h-12 w-12 items-center justify-center rounded-lg border text-sm font-semibold transition-colors',
              'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
              value === n
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-foreground hover:bg-accent',
            ].join(' ')}
            aria-label={`${n} people`}
          >
            {n}
          </button>
        ))}
        {/* 10+ button */}
        <button
          type="button"
          onClick={() => onChange(Math.max(10, value))}
          aria-pressed={isCustom}
          className={[
            'flex h-12 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition-colors',
            'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
            isCustom
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background text-foreground hover:bg-accent',
          ].join(' ')}
          aria-label="More than 9 people"
        >
          10+
        </button>
      </div>

      {/* Custom number input when 10+ selected */}
      {isCustom && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onChange(Math.max(10, value - 1))}
            aria-label="Decrease"
            className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex h-12 w-12 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="min-w-[3ch] text-center text-xl font-semibold" aria-live="polite">
            {value}
          </span>
          <button
            type="button"
            onClick={() => onChange(Math.min(1000, value + 1))}
            aria-label="Increase"
            className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex h-12 w-12 items-center justify-center rounded-lg border focus-visible:outline-none focus-visible:ring-2"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function Step2({
  formState,
  updateState,
  userId,
  onBack,
  onNext,
}: {
  formState: FormState;
  updateState: (patch: Partial<FormState>) => void;
  userId: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const { lat, lng, error: geoError, isLoading: geoLoading } = useGeolocation();
  const [descError, setDescError] = React.useState<string | null>(null);
  const [localName, setLocalName] = React.useState('');
  const [geocoding, setGeocoding] = React.useState(false);

  // Reverse-geocode once we have coordinates.
  React.useEffect(() => {
    if (lat == null || lng == null) return;
    updateState({ gpsLat: lat, gpsLng: lng });
    setGeocoding(true);
    const key = process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'];
    if (!key) {
      updateState({ locationName: `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
      setGeocoding(false);
      return;
    }

    fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`)
      .then((r) => r.json())
      .then((data: { results?: Array<{ formatted_address?: string }> }) => {
        const name = data.results?.[0]?.formatted_address ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        updateState({ locationName: name });
        setLocalName(name);
      })
      .catch(() => {
        updateState({ locationName: `${lat?.toFixed(4)}, ${lng?.toFixed(4)}` });
      })
      .finally(() => setGeocoding(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  const validate = (): boolean => {
    if (formState.description.trim().length < 10 && formState.voiceBase64 === null) {
      setDescError(t('report.step2.text.min'));
      return false;
    }
    setDescError(null);
    return true;
  };

  const handleNext = () => {
    if (validate()) onNext();
  };

  const locationDisplay = formState.isEditingLocation
    ? formState.locationOverride
    : formState.locationName;

  return (
    <div className="space-y-5">
      {/* Location */}
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">{t('report.step2.location.label')}</p>
        {geoLoading || geocoding ? (
          <div className="border-border bg-secondary text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            {t('report.step2.location.detecting')}
          </div>
        ) : formState.isEditingLocation ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={formState.locationOverride}
              onChange={(e) => updateState({ locationOverride: e.target.value })}
              placeholder={t('report.step2.location.manual.placeholder')}
              aria-label={t('report.step2.location.manual')}
              className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring flex-1 rounded-lg border px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2"
            />
            <button
              type="button"
              onClick={() => {
                updateState({
                  locationName: formState.locationOverride || formState.locationName,
                  isEditingLocation: false,
                });
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2"
            >
              Save
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="border-border bg-secondary/50 flex flex-1 items-start gap-2 rounded-lg border px-3 py-2.5">
              {geoError != null ? (
                <MapPinOff
                  className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <MapPin className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <p className="text-foreground line-clamp-2 text-sm">
                {locationDisplay || (geoError != null ? t('report.error.location') : '…')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                updateState({ isEditingLocation: true, locationOverride: formState.locationName });
                setLocalName(formState.locationName);
              }}
              aria-label={t('report.step2.location.edit')}
              className="border-border bg-background text-muted-foreground hover:bg-accent focus-visible:ring-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Voice recorder */}
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">{t('report.step2.voice.label')}</p>
        <VoiceRecorder onRecorded={(base64) => updateState({ voiceBase64: base64 })} />
      </div>

      {/* Text description */}
      <div className="space-y-1.5">
        <label htmlFor="description" className="text-foreground block text-sm font-medium">
          {t('report.step2.text.label')}
        </label>
        <textarea
          id="description"
          value={formState.description}
          onChange={(e) => {
            updateState({ description: e.target.value });
            if (descError !== null && e.target.value.trim().length >= 10) setDescError(null);
          }}
          placeholder={t('report.step2.text.placeholder')}
          aria-invalid={descError !== null}
          aria-describedby={descError !== null ? 'desc-error' : undefined}
          rows={4}
          className={[
            'bg-background text-foreground placeholder:text-muted-foreground w-full resize-none rounded-xl border px-3 py-2.5 text-sm',
            'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
            descError !== null ? 'border-destructive' : 'border-border',
          ].join(' ')}
        />
        {descError !== null && (
          <p
            id="desc-error"
            role="alert"
            className="text-destructive flex items-center gap-1.5 text-sm"
          >
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {descError}
          </p>
        )}
      </div>

      {/* Photo */}
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">{t('report.step2.photo.label')}</p>
        <PhotoUploader userId={userId} onUploaded={(url) => updateState({ photoUrl: url })} />
      </div>

      {/* People count */}
      <div className="space-y-2">
        <p className="text-foreground text-sm font-medium">{t('report.step2.count.label')}</p>
        <PeopleStepper
          value={formState.affectedCount}
          onChange={(n) => updateState({ affectedCount: n })}
        />
      </div>

      {/* Vulnerable flag */}
      <label className="border-border bg-card flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3">
        <input
          type="checkbox"
          checked={formState.hasVulnerable}
          onChange={(e) => updateState({ hasVulnerable: e.target.checked })}
          className="border-border accent-primary focus-visible:ring-ring h-5 w-5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
          aria-label={t('report.step2.vulnerable.label')}
        />
        <span className="text-foreground text-sm">{t('report.step2.vulnerable.label')}</span>
      </label>

      {/* Navigation */}
      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onBack}
          className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex min-h-[48px] items-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {t('report.nav.back')}
        </button>
        <button
          type="button"
          onClick={handleNext}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          {t('report.nav.next')}
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Confirmation
// ---------------------------------------------------------------------------

function Step3({
  formState,
  onBack,
  onSubmit,
  submitting,
  isOnline,
  pendingCount,
}: {
  formState: FormState;
  onBack: () => void;
  onSubmit: () => Promise<void>;
  submitting: boolean;
  isOnline: boolean;
  pendingCount: number;
}) {
  const needEntry = NEED_TYPES.find((n) => n.type === formState.type);

  return (
    <div className="space-y-5">
      <h2 className="text-foreground text-lg font-semibold">{t('report.step3.title')}</h2>

      {/* Summary card */}
      <div className="divide-border border-border bg-card divide-y rounded-xl border">
        {/* Need type */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${needEntry?.color ?? ''}`}
            aria-hidden="true"
          >
            {needEntry?.icon}
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t('report.step3.type')}</p>
            <p className="text-foreground font-medium">
              {formState.type != null
                ? t(`report.type.${formState.type}` as Parameters<typeof t>[0])
                : ''}
            </p>
          </div>
        </div>

        {/* Location */}
        <div className="flex items-start gap-3 px-4 py-3">
          <MapPin className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-muted-foreground text-xs">{t('report.step3.location')}</p>
            <p className="text-foreground text-sm">
              {formState.locationName || formState.locationOverride}
            </p>
          </div>
        </div>

        {/* Description */}
        {formState.description.trim().length > 0 && (
          <div className="px-4 py-3">
            <p className="text-muted-foreground text-xs">{t('report.step3.description')}</p>
            <p className="text-foreground mt-0.5 line-clamp-3 text-sm">{formState.description}</p>
          </div>
        )}

        {/* Attachments */}
        <div className="flex flex-wrap gap-3 px-4 py-3">
          {formState.voiceBase64 !== null && (
            <span className="bg-secondary text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              {t('report.step3.voice')}
            </span>
          )}
          {formState.photoUrl !== null && (
            <span className="bg-secondary text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
              <Camera className="h-3.5 w-3.5" aria-hidden="true" />
              {t('report.step3.photo')}
            </span>
          )}
          <span className="bg-secondary text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {t('report.step3.count', { count: formState.affectedCount })}
          </span>
          {formState.hasVulnerable && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {t('report.step3.vulnerable')}
            </span>
          )}
        </div>
      </div>

      {/* Offline notice */}
      {!isOnline && (
        <div
          role="status"
          aria-live="polite"
          className="border-warning/30 bg-warning/5 text-foreground flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
        >
          <WifiOff className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p>{t('report.step3.offline_note')}</p>
            {pendingCount > 0 && (
              <p className="text-muted-foreground mt-0.5">
                {t('report.step3.queue_note', { count: pendingCount })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex min-h-[48px] items-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {t('report.nav.back')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          aria-busy={submitting}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              {t('report.step3.submitting')}
            </>
          ) : (
            <>
              <Send className="h-5 w-5" aria-hidden="true" />
              {t('report.step3.submit')}
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

export function NeedReportForm({ userId, onSuccess }: NeedReportFormProps) {
  const [step, setStep] = React.useState<Step>(1);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const { isOnline } = useOffline();
  const { pendingCount, enqueue } = useOfflineQueue((reportId) => {
    // Synced from offline queue — could trigger a toast from the parent.
    void reportId;
  });

  const [form, setForm] = React.useState<FormState>({
    type: null,
    description: '',
    voiceBase64: null,
    photoUrl: null,
    affectedCount: 1,
    hasVulnerable: false,
    locationName: '',
    locationOverride: '',
    isEditingLocation: false,
    gpsLat: null,
    gpsLng: null,
  });

  const update = (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSubmit = async () => {
    if (form.type === null) return;
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

    const location = {
      lat: form.gpsLat ?? 0,
      lng: form.gpsLng ?? 0,
      address: locationName,
    };

    const payload = {
      type: form.type,
      description: form.description || '(voice note only)',
      originalDescription: form.description || '(voice note only)',
      originalLanguage: 'en',
      voiceNoteUrl: form.voiceBase64, // base64 data URL — server can upload to Storage
      photoUrls: form.photoUrl !== null ? [form.photoUrl] : [],
      location,
      locationName,
      affectedCount: form.affectedCount,
      hasVulnerable: form.hasVulnerable,
      disasterEventId: ACTIVE_DISASTER_ID,
    };

    if (!isOnline) {
      await enqueue({ id: reportId, ...payload, photoUrls: payload.photoUrls });
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
        throw new Error(body.error?.message ?? t('report.error.submit'));
      }

      const data = (await res.json()) as { data?: { reportId?: string } };
      const finalReportId = data.data?.reportId ?? reportId;

      // Fire-and-forget: AI classification in background — enriches the report
      // without blocking the citizen's confirmation screen.
      void fetch('/api/ai/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: payload.description,
          photoUrls: payload.photoUrls,
          language: 'en',
          reportId: finalReportId,
        }),
      }).catch(() => {
        /* non-fatal */
      });

      setSubmitting(false);
      onSuccess(finalReportId, false);
    } catch (err) {
      // Network failure mid-flight — queue and treat as offline.
      const msg = err instanceof Error ? err.message : t('report.error.submit');
      if (!navigator.onLine) {
        await enqueue({ id: reportId, ...payload, photoUrls: payload.photoUrls });
        setSubmitting(false);
        onSuccess(reportId, true);
        return;
      }
      setSubmitError(msg);
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Step indicator */}
      <StepIndicator step={step} />

      {/* Step content */}
      {step === 1 && (
        <Step1
          selected={form.type}
          onSelect={(type) => update({ type })}
          onNext={() => {
            if (form.type !== null) setStep(2);
          }}
        />
      )}

      {step === 2 && (
        <Step2
          formState={form}
          updateState={update}
          userId={userId}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <Step3
          formState={form}
          onBack={() => setStep(2)}
          onSubmit={handleSubmit}
          submitting={submitting}
          isOnline={isOnline}
          pendingCount={pendingCount}
        />
      )}

      {/* Submit error */}
      {submitError !== null && (
        <div
          role="alert"
          aria-live="assertive"
          className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {submitError}
          <button
            type="button"
            onClick={() => setSubmitError(null)}
            className="focus-visible:ring-ring ml-auto rounded text-xs underline hover:no-underline focus-visible:outline-none focus-visible:ring-1"
          >
            {t('common.retry')}
          </button>
        </div>
      )}
    </div>
  );
}
