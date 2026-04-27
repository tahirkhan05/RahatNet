'use client';

/**
 * OtpVerifyForm — 6-digit OTP entry with:
 *  - Auto-advance focus between digit boxes
 *  - Auto-submit when the 6th digit is entered
 *  - Paste handling (e.g. user copies the SMS code)
 *  - 60-second countdown with resend capability
 *  - Typed error messages for wrong OTP and expired OTP
 *  - "Change number" back link
 *  - Keyboard navigation: Backspace clears and moves back
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { t } from '@/lib/i18n/t';
import {
  getPendingConfirmation,
  clearPendingConfirmation,
} from '@/components/auth/LoginForm';

const OTP_LENGTH = 6;
const RESEND_TIMEOUT_SECS = 60;

// ---------------------------------------------------------------------------
// Digit input
// ---------------------------------------------------------------------------

interface DigitInputProps {
  index: number;
  value: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onChange: (index: number, char: string) => void;
  onBackspace: (index: number) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  disabled: boolean;
  hasError: boolean;
}

function DigitInput({
  index,
  value,
  inputRef,
  onChange,
  onBackspace,
  onPaste,
  disabled,
  hasError,
}: DigitInputProps) {
  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={1}
      value={value}
      aria-label={`OTP digit ${index + 1} of ${OTP_LENGTH}`}
      aria-invalid={hasError}
      disabled={disabled}
      onPaste={onPaste}
      onChange={(e) => {
        const char = e.target.value.replace(/\D/g, '').slice(-1);
        onChange(index, char);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Backspace') {
          e.preventDefault();
          onBackspace(index);
        }
      }}
      // Select all text on focus so re-entering a digit is easy.
      onFocus={(e) => e.target.select()}
      className={[
        'h-12 w-10 rounded-lg border bg-background text-center text-xl font-semibold text-foreground',
        'transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        hasError ? 'border-destructive text-destructive' : 'border-border',
        value.length > 0 ? 'border-primary bg-primary/5' : '',
      ].join(' ')}
    />
  );
}

// ---------------------------------------------------------------------------
// Main form
// ---------------------------------------------------------------------------

export function OtpVerifyForm() {
  const router = useRouter();
  const [digits, setDigits] = React.useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = React.useState(RESEND_TIMEOUT_SECS);
  const [resendLoading, setResendLoading] = React.useState(false);
  const [verified, setVerified] = React.useState(false);

  const inputRefs = React.useRef<Array<React.RefObject<HTMLInputElement>>>(
    Array.from({ length: OTP_LENGTH }, () => React.createRef<HTMLInputElement>()),
  );

  // The phone number stored when the login form sent the OTP.
  const phone = React.useMemo(
    () => (typeof window !== 'undefined' ? sessionStorage.getItem('rn-otp-phone') : null),
    [],
  );

  // If there's no pending confirmation (page was reloaded), redirect back to login.
  React.useEffect(() => {
    if (getPendingConfirmation() === null) {
      router.replace('/login');
    }
  }, [router]);

  // ---- Countdown timer ----
  React.useEffect(() => {
    if (resendSeconds <= 0) return;
    const id = setTimeout(() => setResendSeconds((s) => s - 1), 1_000);
    return () => clearTimeout(id);
  }, [resendSeconds]);

  // ---- Focus first input on mount ----
  React.useEffect(() => {
    inputRefs.current[0]?.current?.focus();
  }, []);

  // ---- Auto-submit when all 6 digits are filled ----
  const joinedDigits = digits.join('');
  React.useEffect(() => {
    if (joinedDigits.length === OTP_LENGTH && !loading) {
      void handleVerify(joinedDigits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedDigits]);

  const handleDigitChange = (index: number, char: string) => {
    setError(null);
    const next = [...digits];
    next[index] = char;
    setDigits(next);

    // Auto-advance focus to next input.
    if (char.length > 0 && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.current?.focus();
    }
  };

  const handleBackspace = (index: number) => {
    setError(null);
    const next = [...digits];
    if (next[index] !== '') {
      // Clear this digit.
      next[index] = '';
    } else if (index > 0) {
      // Move back and clear previous digit.
      next[index - 1] = '';
      inputRefs.current[index - 1]?.current?.focus();
    }
    setDigits(next);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (pasted.length === 0) return;

    const next = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i] ?? '';
    }
    setDigits(next);

    // Focus the next unfilled box, or the last one.
    const nextFocus = Math.min(pasted.length, OTP_LENGTH - 1);
    inputRefs.current[nextFocus]?.current?.focus();
  };

  const handleVerify = async (code: string) => {
    const confirmation = getPendingConfirmation();
    if (confirmation === null) {
      router.replace('/login');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { verifyOTP } = await import('@/lib/firebase/auth');
      await verifyOTP(confirmation, code);

      clearPendingConfirmation();
      sessionStorage.removeItem('rn-otp-phone');
      setVerified(true);
      // AuthProvider detects the auth state change and navigates.
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('auth.verify.error.generic');
      setError(msg);
      // Clear the digits so the user re-enters cleanly.
      setDigits(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    const storedPhone = sessionStorage.getItem('rn-otp-phone');
    if (storedPhone === null) {
      router.replace('/login');
      return;
    }

    setResendLoading(true);
    setError(null);

    try {
      const { signInWithPhone, resetRecaptchaVerifier } = await import('@/lib/firebase/auth');
      const { setPendingConfirmation } = await import('@/components/auth/LoginForm');

      // Reset reCAPTCHA verifier so a fresh challenge is issued.
      resetRecaptchaVerifier();
      const newResult = await signInWithPhone(storedPhone, 'recaptcha-container-verify');

      // Update the module-level cache with the new ConfirmationResult.
      setPendingConfirmation(newResult);

      // Reset the countdown and clear the digit boxes.
      setResendSeconds(RESEND_TIMEOUT_SECS);
      setDigits(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.current?.focus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common.error.generic');
      setError(msg);
    } finally {
      setResendLoading(false);
    }
  };

  // ---- Success state ----
  if (verified) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
          <ShieldCheck className="h-7 w-7" aria-hidden="true" />
        </div>
        <p className="font-medium text-foreground">Verified! Signing you in…</p>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">{t('auth.verify.title')}</h1>
        {phone != null && (
          <p className="text-sm text-muted-foreground">
            {t('auth.verify.subtitle')}{' '}
            <span className="font-medium text-foreground">{phone}</span>
          </p>
        )}
      </div>

      {/* OTP inputs */}
      <div
        role="group"
        aria-label="6-digit OTP"
        className="flex justify-center gap-2"
      >
        {digits.map((digit, i) => (
          <DigitInput
            key={i}
            index={i}
            value={digit}
            inputRef={inputRefs.current[i] as React.RefObject<HTMLInputElement>}
            onChange={handleDigitChange}
            onBackspace={handleBackspace}
            onPaste={handlePaste}
            disabled={loading}
            hasError={error !== null}
          />
        ))}
      </div>

      {/* Loading indicator */}
      {loading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span aria-live="polite">{t('auth.verify.verifying')}</span>
        </div>
      )}

      {/* Error */}
      {error !== null && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* Resend / countdown */}
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          onClick={() => router.replace('/login')}
          aria-label={t('auth.verify.back')}
          className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('auth.verify.back')}
        </button>

        {resendSeconds > 0 ? (
          <span className="text-muted-foreground" aria-live="polite">
            {t('auth.verify.resend.in', { seconds: resendSeconds })}
          </span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resendLoading}
            aria-busy={resendLoading}
            className="flex items-center gap-1.5 font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded disabled:opacity-60"
          >
            {resendLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t('auth.verify.resend')}
          </button>
        )}
      </div>

      {/* Invisible reCAPTCHA container for resend */}
      <div id="recaptcha-container-verify" aria-hidden="true" />
    </div>
  );
}
