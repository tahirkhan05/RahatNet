'use client';

/**
 * OnboardingWizard — multi-step profile setup for new RahatNet users.
 *
 * Steps:
 *   1. Role selection (all users)
 *   2a. Volunteer profile — skills, languages, avatar
 *   2b. Coordinator profile — organisation, district, designation
 *   2c. (Citizen — no step 2; goes straight to step 3)
 *   3. Location permission
 *
 * On completion the wizard:
 *   1. Uploads the avatar photo (if provided) to Firebase Storage.
 *   2. Writes the profile document to Firestore (/users/{uid}).
 *   3. Calls POST /api/auth/onboard to set the Firebase Auth custom claim.
 *   4. Calls refreshSession() so the Zustand store has the new role.
 *   5. AuthProvider navigates to the role-appropriate home page.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Users,
  HandHeart,
  LayoutDashboard,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  AlertCircle,
  Upload,
} from 'lucide-react';
import { UserRole, VolunteerSkill, Language } from '@rahatnet/types';
import { t } from '@/lib/i18n/t';
import { SUPPORTED_LANGUAGES } from '@/lib/utils/constants';
import { useAuth } from '@/hooks/useAuth';
import { COLLECTIONS } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Steps vary: Google users get a phone collection step, phone users skip it.
// hasPhone = user already has phoneNumber from Firebase Auth (phone login).
const getTotalSteps = (role: UserRole, hasPhone: boolean) => {
  const phoneStep = hasPhone ? 0 : 1;
  const photoStep = 1; // always shown
  const base: Record<UserRole, number> = {
    [UserRole.CITIZEN]: 2,      // role + location (+ phone? + photo)
    [UserRole.VOLUNTEER]: 3,    // role + skills + location (+ phone? + photo)
    [UserRole.COORDINATOR]: 3,  // role + org + location (+ phone? + photo)
    [UserRole.ADMIN]: 3,
  };
  return (base[role] ?? 2) + phoneStep + photoStep;
};

const SKILL_LABELS: Record<VolunteerSkill, string> = {
  [VolunteerSkill.BOAT_OPERATOR]: '🚤 Boat Operator',
  [VolunteerSkill.DOCTOR]: '🩺 Doctor',
  [VolunteerSkill.NURSE]: '💉 Nurse',
  [VolunteerSkill.COOK]: '🍳 Cook',
  [VolunteerSkill.TRANSLATOR]: '🌐 Translator',
  [VolunteerSkill.RESCUE_SWIMMER]: '🏊 Rescue Swimmer',
  [VolunteerSkill.DRIVER]: '🚗 Driver',
  [VolunteerSkill.COUNSELLOR]: '🧠 Counsellor',
  [VolunteerSkill.ELECTRICIAN]: '⚡ Electrician',
  [VolunteerSkill.CARPENTER]: '🔨 Carpenter',
};

// ---------------------------------------------------------------------------
// Zod schemas (one per step)
// ---------------------------------------------------------------------------

const roleSchema = z.object({
  role: z.nativeEnum(UserRole, { required_error: 'Please select a role.' }),
});

const volunteerSchema = z.object({
  skills: z
    .array(z.nativeEnum(VolunteerSkill))
    .min(1, t('auth.onboarding.skills.required')),
  languages: z.array(z.nativeEnum(Language)).min(1, 'Please select at least one language.'),
  avatarFile: z.instanceof(File).optional(),
});

const coordinatorSchema = z.object({
  organizationName: z.string().min(2, 'Organisation name is required.').max(100),
  designation: z.string().min(2, 'Designation is required.').max(80),
  district: z.string().min(2, 'District is required.').max(60),
});

type RoleValues = z.infer<typeof roleSchema>;
type VolunteerValues = z.infer<typeof volunteerSchema>;
type CoordinatorValues = z.infer<typeof coordinatorSchema>;

// ---------------------------------------------------------------------------
// Step 1: Role selection
// ---------------------------------------------------------------------------

function RoleOption({
  role,
  icon,
  label,
  description,
  selected,
  onSelect,
}: {
  role: UserRole;
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onSelect: (role: UserRole) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(role)}
      className={[
        'rn-pressable flex w-full items-start gap-3 p-4 text-left',
        selected ? 'border-primary bg-primary/5' : '',
      ].join(' ')}
    >
      <div
        className={[
          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          selected ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
        ].join(' ')}
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-foreground">{label}</p>
          {selected && (
            <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function StepRole({
  onNext,
}: {
  onNext: (role: UserRole) => void;
}) {
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<RoleValues>({
    resolver: zodResolver(roleSchema),
  });
  const selectedRole = watch('role');

  return (
    <form onSubmit={handleSubmit((v) => onNext(v.role))} noValidate>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('auth.onboarding.role.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('auth.onboarding.role.subtitle')}
          </p>
        </div>

        <div role="radiogroup" aria-label="Role selection" className="space-y-2">
          <input type="hidden" {...register('role')} />
          <RoleOption
            role={UserRole.CITIZEN}
            icon={<Users className="h-5 w-5" />}
            label={t('auth.onboarding.role.citizen')}
            description={t('auth.onboarding.role.citizen.desc')}
            selected={selectedRole === UserRole.CITIZEN}
            onSelect={(r) => setValue('role', r, { shouldValidate: true })}
          />
          <RoleOption
            role={UserRole.VOLUNTEER}
            icon={<HandHeart className="h-5 w-5" />}
            label={t('auth.onboarding.role.volunteer')}
            description={t('auth.onboarding.role.volunteer.desc')}
            selected={selectedRole === UserRole.VOLUNTEER}
            onSelect={(r) => setValue('role', r, { shouldValidate: true })}
          />
          <RoleOption
            role={UserRole.COORDINATOR}
            icon={<LayoutDashboard className="h-5 w-5" />}
            label={t('auth.onboarding.role.coordinator')}
            description={t('auth.onboarding.role.coordinator.desc')}
            selected={selectedRole === UserRole.COORDINATOR}
            onSelect={(r) => setValue('role', r, { shouldValidate: true })}
          />
        </div>

        {errors.role != null && (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {errors.role.message}
          </p>
        )}

        <button
          type="submit"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-[48px]"
        >
          {t('auth.onboarding.next')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2a: Volunteer details
// ---------------------------------------------------------------------------

function SkillToggle({
  skill,
  selected,
  onToggle,
}: {
  skill: VolunteerSkill;
  selected: boolean;
  onToggle: (skill: VolunteerSkill) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={() => onToggle(skill)}
      className={[
        'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-border bg-background text-foreground hover:bg-accent',
      ].join(' ')}
    >
      {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {SKILL_LABELS[skill]}
    </button>
  );
}

function StepVolunteer({
  onNext,
  onBack,
}: {
  onNext: (values: VolunteerValues) => void;
  onBack: () => void;
}) {
  const { handleSubmit, watch, setValue, formState: { errors } } = useForm<VolunteerValues>({
    resolver: zodResolver(volunteerSchema),
    defaultValues: { skills: [], languages: [] },
  });

  const selectedSkills = watch('skills');
  const selectedLanguages = watch('languages');
  const avatarFile = watch('avatarFile');
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(null);

  const toggleSkill = (skill: VolunteerSkill) => {
    const current = selectedSkills ?? [];
    const next = current.includes(skill)
      ? current.filter((s) => s !== skill)
      : [...current, skill];
    setValue('skills', next, { shouldValidate: true });
  };

  const toggleLanguage = (lang: Language) => {
    const current = selectedLanguages ?? [];
    const next = current.includes(lang)
      ? current.filter((l) => l !== lang)
      : [...current, lang];
    setValue('languages', next, { shouldValidate: true });
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file == null) return;
    setValue('avatarFile', file);
    const url = URL.createObjectURL(file);
    setAvatarPreview(url);
  };

  React.useEffect(() => {
    return () => {
      if (avatarPreview != null) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

  return (
    <form onSubmit={handleSubmit(onNext)} noValidate>
      <div className="space-y-5">
        {/* Skills */}
        <div>
          <h3 className="font-medium text-foreground">{t('auth.onboarding.skills.title')}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('auth.onboarding.skills.subtitle')}
          </p>
          <div
            role="group"
            aria-label="Skills"
            className="mt-3 flex flex-wrap gap-2"
          >
            {Object.values(VolunteerSkill).map((skill) => (
              <SkillToggle
                key={skill}
                skill={skill}
                selected={selectedSkills?.includes(skill) ?? false}
                onToggle={toggleSkill}
              />
            ))}
          </div>
          {errors.skills != null && (
            <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {errors.skills.message}
            </p>
          )}
        </div>

        {/* Languages */}
        <div>
          <h3 className="font-medium text-foreground">{t('auth.onboarding.languages.title')}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('auth.onboarding.languages.subtitle')}
          </p>
          <div
            role="group"
            aria-label="Languages"
            className="mt-3 flex flex-wrap gap-2"
          >
            {SUPPORTED_LANGUAGES.map((lang) => {
              const isSelected = selectedLanguages?.includes(lang.code as Language) ?? false;
              return (
                <button
                  key={lang.code}
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  onClick={() => toggleLanguage(lang.code as Language)}
                  className={[
                    'rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border bg-background text-foreground hover:bg-accent',
                  ].join(' ')}
                >
                  {lang.nativeName}
                </button>
              );
            })}
          </div>
          {errors.languages != null && (
            <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {errors.languages.message}
            </p>
          )}
        </div>

        {/* Avatar */}
        <div>
          <p className="text-sm font-medium text-foreground">{t('auth.onboarding.avatar.label')}</p>
          <div className="mt-2 flex items-center gap-3">
            <div
              className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-secondary"
              aria-hidden="true"
            >
              {avatarPreview != null ? (
                <img src={avatarPreview} alt="Avatar preview" className="h-full w-full object-cover" />
              ) : (
                <Upload className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <div>
              <label
                htmlFor="avatar-upload"
                className="cursor-pointer rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
              >
                {avatarFile != null ? t('auth.onboarding.avatar.change') : t('auth.onboarding.avatar.change')}
                <input
                  id="avatar-upload"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={handleAvatarChange}
                />
              </label>
              {avatarFile != null && (
                <button
                  type="button"
                  onClick={() => {
                    setValue('avatarFile', undefined);
                    setAvatarPreview(null);
                  }}
                  className="ml-2 text-sm text-muted-foreground hover:text-destructive"
                >
                  {t('auth.onboarding.avatar.remove')}
                </button>
              )}
            </div>
          </div>
        </div>

        <WizardNav onBack={onBack} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2b: Coordinator details
// ---------------------------------------------------------------------------

function StepCoordinator({
  onNext,
  onBack,
}: {
  onNext: (values: CoordinatorValues) => void;
  onBack: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CoordinatorValues>({
    resolver: zodResolver(coordinatorSchema),
  });

  return (
    <form onSubmit={handleSubmit(onNext)} noValidate>
      <div className="space-y-4">
        <h3 className="font-medium text-foreground">{t('auth.onboarding.org.title')}</h3>

        <div className="space-y-1">
          <label htmlFor="org-name" className="block text-sm font-medium text-foreground">
            {t('auth.onboarding.org.name.label')}
          </label>
          <input
            id="org-name"
            type="text"
            autoComplete="organization"
            placeholder={t('auth.onboarding.org.name.placeholder')}
            aria-invalid={errors.organizationName != null}
            {...register('organizationName')}
            className={inputCls(errors.organizationName != null)}
          />
          {errors.organizationName != null && <FieldError msg={errors.organizationName.message} />}
        </div>

        <div className="space-y-1">
          <label htmlFor="designation" className="block text-sm font-medium text-foreground">
            {t('auth.onboarding.org.designation.label')}
          </label>
          <input
            id="designation"
            type="text"
            placeholder={t('auth.onboarding.org.designation.placeholder')}
            aria-invalid={errors.designation != null}
            {...register('designation')}
            className={inputCls(errors.designation != null)}
          />
          {errors.designation != null && <FieldError msg={errors.designation.message} />}
        </div>

        <div className="space-y-1">
          <label htmlFor="district" className="block text-sm font-medium text-foreground">
            {t('auth.onboarding.org.district.label')}
          </label>
          <input
            id="district"
            type="text"
            placeholder={t('auth.onboarding.org.district.placeholder')}
            aria-invalid={errors.district != null}
            {...register('district')}
            className={inputCls(errors.district != null)}
          />
          {errors.district != null && <FieldError msg={errors.district.message} />}
        </div>

        <WizardNav onBack={onBack} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Location permission
// ---------------------------------------------------------------------------

function StepLocation({
  onFinish,
  onBack,
  loading,
}: {
  onFinish: (granted: boolean) => void;
  onBack: () => void;
  loading: boolean;
}) {
  const [permissionState, setPermissionState] = React.useState<
    'idle' | 'requesting' | 'granted' | 'denied'
  >('idle');

  const requestLocation = async () => {
    setPermissionState('requesting');
    try {
      await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10_000 }),
      );
      setPermissionState('granted');
      // Small delay so the user sees the granted state before we navigate away.
      await new Promise((r) => setTimeout(r, 800));
      onFinish(true);
    } catch {
      setPermissionState('denied');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <div
          className={[
            'flex h-14 w-14 items-center justify-center rounded-full',
            permissionState === 'granted'
              ? 'bg-success/10 text-success'
              : permissionState === 'denied'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-primary/10 text-primary',
          ].join(' ')}
          aria-hidden="true"
        >
          <MapPin className="h-7 w-7" />
        </div>

        <div>
          <h3 className="font-semibold text-foreground">{t('auth.onboarding.location.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {permissionState === 'granted'
              ? t('auth.onboarding.location.granted')
              : permissionState === 'denied'
              ? t('auth.onboarding.location.denied')
              : t('auth.onboarding.location.subtitle')}
          </p>
        </div>

        {permissionState !== 'denied' && permissionState !== 'granted' && (
          <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
            🔒 {t('auth.onboarding.location.why')}
          </p>
        )}
      </div>

      <div className="space-y-2">
        {permissionState !== 'granted' && (
          <button
            type="button"
            onClick={requestLocation}
            disabled={loading || permissionState === 'requesting'}
            aria-busy={permissionState === 'requesting'}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-[48px] disabled:opacity-60"
          >
            {(loading || permissionState === 'requesting') && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t('auth.onboarding.location.allow')}
          </button>
        )}

        <button
          type="button"
          onClick={() => onFinish(false)}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[48px] disabled:opacity-60"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('auth.onboarding.location.skip')}
        </button>
      </div>

      <button
        type="button"
        onClick={onBack}
        disabled={loading}
        className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('auth.onboarding.back')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function inputCls(hasError: boolean) {
  return [
    'w-full rounded-lg border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
    hasError ? 'border-destructive' : 'border-border',
  ].join(' ');
}

function FieldError({ msg }: { msg?: string }) {
  if (msg == null) return null;
  return (
    <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {msg}
    </p>
  );
}

function WizardNav({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center justify-between pt-1">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('auth.onboarding.back')}
      </button>
      <button
        type="submit"
        className="flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {t('auth.onboarding.next')}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function StepProgress({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('auth.onboarding.step', { current, total })}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Onboarding progress"
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard orchestrator
// ---------------------------------------------------------------------------

type WizardStep = 'role' | 'volunteer' | 'coordinator' | 'phone' | 'photo' | 'location';

interface WizardState {
  role: UserRole | null;
  volunteerValues: VolunteerValues | null;
  coordinatorValues: CoordinatorValues | null;
  phone: string | null;
  avatarFile: File | null;
}

// ---------------------------------------------------------------------------
// Step: Phone number collection (for Google sign-in users)
// ---------------------------------------------------------------------------

function StepPhone({ onNext, onBack }: { onNext: (phone: string) => void; onBack: () => void }) {
  const [phone, setPhone] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) {
      setError('Enter a valid 10-digit Indian mobile number.');
      return;
    }
    onNext(`+91${digits}`);
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Your phone number</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Used so others can contact you during a disaster. Optional — you can skip.
        </p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          Mobile number
        </label>
        <div className="flex gap-2">
          <span className="flex items-center rounded-lg border border-border bg-muted px-3 text-sm text-muted-foreground">
            🇮🇳 +91
          </span>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={phone}
            onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '')); setError(null); }}
            placeholder="98765 43210"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
      </div>

      <div className="flex gap-3">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-accent">
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <button type="submit"
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 min-h-[48px]">
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <button type="button" onClick={() => onNext('')}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground">
        Skip for now
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step: Profile photo (all roles)
// ---------------------------------------------------------------------------

function StepPhoto({ onNext, onBack, existingPhotoUrl }: {
  onNext: (file: File | null) => void;
  onBack: () => void;
  existingPhotoUrl?: string | null;
}) {
  const [preview, setPreview] = React.useState<string | null>(existingPhotoUrl ?? null);
  const [file, setFile] = React.useState<File | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  React.useEffect(() => () => { if (preview && preview.startsWith('blob:')) URL.revokeObjectURL(preview); }, [preview]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Add a profile photo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Helps volunteers and coordinators identify you. You can skip this.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4">
        {preview ? (
          <img src={preview} alt="Preview" className="h-24 w-24 rounded-full object-cover border-4 border-primary/30" />
        ) : (
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-muted border-2 border-dashed border-border">
            <Upload className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <label className="cursor-pointer rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent">
          {preview ? 'Change photo' : 'Choose photo'}
          <input type="file" accept="image/*" capture="user" onChange={handleChange} className="sr-only" />
        </label>
      </div>

      <div className="flex gap-3">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-accent">
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <button type="button" onClick={() => onNext(file)}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 min-h-[48px]">
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <button type="button" onClick={() => onNext(null)}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground">
        Skip for now
      </button>
    </div>
  );
}

const ROLE_HOME: Record<UserRole, string> = {
  [UserRole.CITIZEN]: '/citizen',
  [UserRole.VOLUNTEER]: '/volunteer',
  [UserRole.COORDINATOR]: '/coordinator',
  [UserRole.ADMIN]: '/coordinator',
};

export function OnboardingWizard() {
  const { user, refreshSession } = useAuth();
  const router = useRouter();
  const [step, setStep] = React.useState<WizardStep>('role');
  const [state, setState] = React.useState<WizardState>({
    role: null,
    volunteerValues: null,
    coordinatorValues: null,
    phone: null,
    avatarFile: null,
  });
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const selectedRole = state.role ?? UserRole.CITIZEN;
  const hasPhone = !!(user?.phoneNumber);
  const totalSteps = getTotalSteps(selectedRole, hasPhone);

  const currentStepNumber = (() => {
    switch (step) {
      case 'role': return 1;
      case 'volunteer':
      case 'coordinator': return 2;
      case 'phone': return hasPhone ? 2 : 2;
      case 'photo': return hasPhone ? 2 : 3;
      case 'location': return totalSteps;
    }
  })();

  const goToPhoneOrLocation = () => {
    if (hasPhone) setStep('photo');
    else setStep('phone');
  };

  // ---- Step handlers ----

  const handleRoleNext = (role: UserRole) => {
    setState((s) => ({ ...s, role }));
    if (role === UserRole.VOLUNTEER) setStep('volunteer');
    else if (role === UserRole.COORDINATOR || role === UserRole.ADMIN) setStep('coordinator');
    else goToPhoneOrLocation();
  };

  const handleVolunteerNext = (values: VolunteerValues) => {
    setState((s) => ({ ...s, volunteerValues: values }));
    goToPhoneOrLocation();
  };

  const handleCoordinatorNext = (values: CoordinatorValues) => {
    setState((s) => ({ ...s, coordinatorValues: values }));
    goToPhoneOrLocation();
  };

  const handleLocationFinish = async (locationGranted: boolean) => {
    if (user == null) return;
    setSaving(true);
    setSaveError(null);

    try {
      // 1. Upload avatar if volunteer provided one.
      // Non-fatal — if Storage rules aren't deployed yet, skip and use existing photo.
      let photoURL: string | null = user.photoURL ?? null;
      // Use volunteer's avatar if provided, otherwise use citizen/coordinator photo
      const avatarFile = state.volunteerValues?.avatarFile ?? state.avatarFile;
      if (avatarFile != null) {
        try {
          const { uploadProfilePhoto } = await import('@/lib/firebase/storage');
          photoURL = await uploadProfilePhoto(user.uid, avatarFile);
        } catch {
          // Storage upload failed (e.g. rules not deployed) — continue without photo.
        }
      }

      // 2. Build the Firestore profile document.
      const role = state.role ?? UserRole.CITIZEN;
      const { serverTimestamp } = await import('@/lib/firebase/firestore');

      const baseProfile = {
        uid: user.uid,
        phoneNumber: user.phoneNumber ?? state.phone ?? null,
        email: user.email ?? null,
        displayName: user.displayName ?? '',
        photoURL,
        role,
        language: 'en',
        district: state.coordinatorValues?.district ?? '',
        state: '',
        fcmToken: null,
        onboardingStatus: 'COMPLETED' as const,
        notificationPreferences: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      const profileData =
        role === UserRole.VOLUNTEER
          ? {
              ...baseProfile,
              skills: state.volunteerValues?.skills ?? [],
              languages: state.volunteerValues?.languages ?? [],
              isAvailable: false,
              availabilityStatus: 'UNAVAILABLE',
              verificationStatus: 'PENDING',
              stats: {
                tasksCompleted: 0,
                completionRate: 0,
                averageRating: null,
                avgResponseTimeMinutes: null,
                lastActiveAt: null,
              },
              activeAssignmentId: null,
            }
          : role === UserRole.COORDINATOR || role === UserRole.ADMIN
          ? {
              ...baseProfile,
              organizationName: state.coordinatorValues?.organizationName ?? '',
              designation: state.coordinatorValues?.designation ?? '',
              managedDistricts: [state.coordinatorValues?.district ?? ''],
              assignedDisasters: [],
            }
          : {
              ...baseProfile,
              reportIds: [],
            };

      // 3. Write to Firestore.
      const { setDocument } = await import('@/lib/firebase/firestore');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setDocument(COLLECTIONS.USERS, user.uid, profileData as any);

      // 4. Set the Firebase Auth custom claim via the API.
      // 409 = already onboarded (e.g. user refreshed mid-wizard) — treat as success.
      const onboardRes = await fetch('/api/auth/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!onboardRes.ok && onboardRes.status !== 409) {
        throw new Error('Failed to set role. Please try again.');
      }

      // 5. Refresh the session so the Zustand store has the new role claim,
      //    then navigate to the role home page.
      await refreshSession();
      router.replace(ROLE_HOME[role]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common.error.generic');
      setSaveError(msg);
      setSaving(false);
    }
  };

  // ---- Render ----

  return (
    <div className="space-y-5">
      {/* Header + progress */}
      <div className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {t('auth.onboarding.title')}
          </h1>
        </div>
        <StepProgress current={currentStepNumber} total={totalSteps} />
      </div>

      {/* Step content */}
      {step === 'role' && <StepRole onNext={handleRoleNext} />}

      {step === 'volunteer' && (
        <StepVolunteer
          onNext={handleVolunteerNext}
          onBack={() => setStep('role')}
        />
      )}

      {step === 'coordinator' && (
        <StepCoordinator
          onNext={handleCoordinatorNext}
          onBack={() => setStep('role')}
        />
      )}

      {step === 'phone' && (
        <StepPhone
          onNext={(phone) => { setState((s) => ({ ...s, phone })); setStep('photo'); }}
          onBack={() => {
            const role = state.role ?? UserRole.CITIZEN;
            if (role === UserRole.VOLUNTEER) setStep('volunteer');
            else if (role === UserRole.COORDINATOR || role === UserRole.ADMIN) setStep('coordinator');
            else setStep('role');
          }}
        />
      )}

      {step === 'photo' && (
        <StepPhoto
          existingPhotoUrl={user?.photoURL}
          onNext={(file) => { setState((s) => ({ ...s, avatarFile: file })); setStep('location'); }}
          onBack={() => { if (!hasPhone) { setStep('phone'); } else { goToPhoneOrLocation(); } }}
        />
      )}

      {step === 'location' && (
        <StepLocation
          onFinish={handleLocationFinish}
          onBack={() => setStep('photo')}
          loading={saving}
        />
      )}

      {/* Save error */}
      {saveError !== null && (
        <div
          role="alert"
          aria-live="assertive"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {saveError}
        </div>
      )}
    </div>
  );
}
