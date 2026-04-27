'use client';

/**
 * LoginForm — the primary sign-in UI for RahatNet.
 *
 * Renders:
 *  - Offline / slow-connection banner
 *  - Language selector (persisted to localStorage)
 *  - Phone number input with +91 prefix
 *  - "Continue with phone" button → sends OTP → redirects to /verify
 *  - Divider
 *  - "Continue with Google" button → OAuth popup
 *
 * The Firebase RecaptchaVerifier is attached to a hidden div so the
 * invisible reCAPTCHA works without cluttering the layout.
 *
 * On success the component does NOT navigate — AuthProvider's onAuthStateChanged
 * listener detects the sign-in and triggers the redirect.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Phone, Wifi, WifiOff, Globe, Loader2, ChevronDown } from 'lucide-react';
import { t } from '@/lib/i18n/t';
import { SUPPORTED_LANGUAGES } from '@/lib/utils/constants';
import { useOffline } from '@/hooks/useOffline';
// Eagerly imported so signInWithGoogle runs synchronously inside the click
// handler — browsers block popups triggered after async operations.
import { signInWithGoogle } from '@/lib/firebase/auth';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  phone: z
    .string()
    .min(1, t('auth.login.phone.invalid'))
    .regex(/^[6-9]\d{9}$/, t('auth.login.phone.invalid')),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Language selector
// ---------------------------------------------------------------------------

const LANG_STORAGE_KEY = 'rahatnet-lang';

function LanguageSelector() {
  const [selected, setSelected] = React.useState(() => {
    if (typeof window === 'undefined') return 'en';
    return localStorage.getItem(LANG_STORAGE_KEY) ?? 'en';
  });
  const [open, setOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === selected) ?? SUPPORTED_LANGUAGES[8]!;

  const handleSelect = (code: string) => {
    setSelected(code);
    localStorage.setItem(LANG_STORAGE_KEY, code);
    setOpen(false);
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        aria-label={t('auth.login.language.label')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span>{currentLang.nativeName}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={t('auth.login.language.label')}
          className="absolute right-0 top-full z-50 mt-1 max-h-64 w-48 overflow-auto rounded-xl border border-border bg-card shadow-md"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <li key={lang.code} role="option" aria-selected={lang.code === selected}>
              <button
                type="button"
                onClick={() => handleSelect(lang.code)}
                className={[
                  'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors',
                  lang.code === selected
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-foreground hover:bg-accent',
                ].join(' ')}
              >
                <span>{lang.nativeName}</span>
                <span className="text-xs text-muted-foreground">{lang.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offline banner
// ---------------------------------------------------------------------------

function OfflineBanner({ isSlowConnection }: { isSlowConnection: boolean }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{t('auth.login.offline.body')}</p>
    </div>
  );
}

function SlowBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm text-warning-foreground"
    >
      <Wifi className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{t('auth.login.slow.body')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error message
// ---------------------------------------------------------------------------

function FormError({ message }: { message: string }) {
  return (
    <div role="alert" aria-live="assertive" className="flex items-center gap-2 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LoginForm() {
  const router = useRouter();
  const { isOnline, isSlowConnection } = useOffline();

  const [phoneLoading, setPhoneLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    mode: 'onBlur',
  });

  const handlePhoneSubmit = async (values: LoginFormValues) => {
    if (!isOnline) {
      setError(t('common.error.offline'));
      return;
    }
    setError(null);
    setPhoneLoading(true);

    try {
      const { signInWithPhone } = await import('@/lib/firebase/auth');
      const fullPhone = `+91${values.phone}`;
      const confirmationResult = await signInWithPhone(fullPhone, 'recaptcha-container');

      // Store the confirmation result so /verify can access it.
      // We use sessionStorage (not localStorage) so it's cleared when the tab closes.
      sessionStorage.setItem('rn-otp-phone', fullPhone);
      // The ConfirmationResult can't be serialised — store it in a module-level cache.
      pendingConfirmation = confirmationResult;

      router.push('/verify');
    } catch (err) {
      const firebaseCode = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : t('common.error.generic');
      setError(firebaseCode ? `${msg} (${firebaseCode})` : msg);
    } finally {
      setPhoneLoading(false);
    }
  };

  const handleGoogle = async () => {
    if (!isOnline) {
      setError(t('common.error.offline'));
      return;
    }
    setError(null);
    setGoogleLoading(true);

    try {
      await signInWithGoogle();
      // AuthProvider handles the redirect after the auth state resolves.
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common.error.generic');
      setError(msg);
    } finally {
      setGoogleLoading(false);
    }
  };

  const isAnyLoading = phoneLoading || googleLoading;

  return (
    <div className="space-y-5">
      {/* Offline / slow banners */}
      {!isOnline && <OfflineBanner isSlowConnection={isSlowConnection} />}
      {isOnline && isSlowConnection && <SlowBanner />}

      {/* Language selector */}
      <div className="flex justify-end">
        <LanguageSelector />
      </div>

      {/* Phone form */}
      <form onSubmit={handleSubmit(handlePhoneSubmit)} noValidate aria-label="Phone sign-in">
        <div className="space-y-3">
          <label htmlFor="phone" className="block text-sm font-medium text-foreground">
            {t('auth.login.phone.label')}
          </label>

          <div className="flex">
            {/* +91 prefix */}
            <div
              aria-hidden="true"
              className="flex items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-secondary px-3 text-sm font-medium text-foreground-secondary"
            >
              <span>🇮🇳</span>
              <span>{t('auth.login.phone.prefix')}</span>
            </div>
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              aria-label={t('auth.login.phone.label')}
              aria-describedby={errors.phone ? 'phone-error' : undefined}
              aria-invalid={errors.phone != null}
              placeholder={t('auth.login.phone.placeholder')}
              disabled={isAnyLoading || !isOnline}
              {...register('phone')}
              className={[
                'flex-1 rounded-l-none rounded-r-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
                'disabled:cursor-not-allowed disabled:opacity-50',
                errors.phone != null ? 'border-destructive' : '',
              ].join(' ')}
            />
          </div>

          {errors.phone != null && (
            <FormError message={errors.phone.message ?? t('auth.login.phone.invalid')} />
          )}

          <button
            type="submit"
            disabled={isAnyLoading || !isOnline}
            aria-busy={phoneLoading}
            className={[
              'flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground',
              'transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-60',
              'min-h-[48px]',
            ].join(' ')}
          >
            {phoneLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Phone className="h-4 w-4" aria-hidden="true" />
            )}
            {phoneLoading ? t('common.loading') : t('auth.login.continue.phone')}
          </button>
        </div>
      </form>

      {/* Divider */}
      <div className="relative" aria-hidden="true">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-card px-3 text-xs text-muted-foreground">{t('auth.login.divider')}</span>
        </div>
      </div>

      {/* Google sign-in */}
      <button
        type="button"
        onClick={handleGoogle}
        disabled={isAnyLoading || !isOnline}
        aria-busy={googleLoading}
        className={[
          'flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground',
          'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'min-h-[48px]',
        ].join(' ')}
      >
        {googleLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          /* Google 'G' logo SVG — no external dep needed */
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
            />
            <path
              fill="#FBBC05"
              d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
            />
          </svg>
        )}
        {googleLoading ? t('common.loading') : t('auth.login.continue.google')}
      </button>

      {/* Global error */}
      {error !== null && <FormError message={error} />}

      {/* Invisible reCAPTCHA container — required by Firebase Phone Auth */}
      <div id="recaptcha-container" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module-level confirmation result cache
// ---------------------------------------------------------------------------

/**
 * Stores the ConfirmationResult from signInWithPhone so /verify can call
 * confirmationResult.confirm(otp).
 *
 * This cannot be serialised to sessionStorage — it's a live Firebase object.
 * Module-level variable is cleared after OTP verification or on page reload.
 */
import type { ConfirmationResult } from 'firebase/auth';
let pendingConfirmation: ConfirmationResult | null = null;

export function getPendingConfirmation(): ConfirmationResult | null {
  return pendingConfirmation;
}

export function setPendingConfirmation(result: ConfirmationResult): void {
  pendingConfirmation = result;
}

export function clearPendingConfirmation(): void {
  pendingConfirmation = null;
}
