'use client';

/**
 * Firebase Authentication client library.
 *
 * Provides typed wrappers around every Firebase Auth operation used by
 * RahatNet.  All errors are normalised to `AppError` with user-facing
 * messages so UI components never need to inspect raw Firebase error codes.
 *
 * Phone-number OTP is the primary sign-in method for India (no email/password
 * account required — citizens can authenticate with just their phone).
 * Google OAuth is the secondary method for coordinators/NGO staff.
 *
 * The `RecaptchaVerifier` is kept as a module-level singleton and reset when
 * the underlying widget is destroyed (e.g. after a failed attempt).
 *
 * Session persistence model:
 *   Firebase Auth persists the token in IndexedDB (LOCAL persistence).
 *   The server also holds an HttpOnly session cookie (set via setSessionCookie)
 *   so that Next.js middleware and API routes can verify auth without a
 *   round-trip to Firebase on every request.
 */

import {
  getAuth,
  signInWithPhoneNumber,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  RecaptchaVerifier,
  browserLocalPersistence,
  setPersistence,
  type Auth,
  type User,
  type UserCredential,
  type Unsubscribe,
  type ConfirmationResult,
  type AuthError as FirebaseAuthError,
} from 'firebase/auth';
import { firebaseApp } from './client';
import { AppError, AuthError } from '@/lib/utils/errors';
import { createLogger } from './logger';
import type { LogContext } from './logger';

// ---------------------------------------------------------------------------
// Auth singleton
// ---------------------------------------------------------------------------

export const auth: Auth = getAuth(firebaseApp);

// Ensure tokens survive page refreshes in the browser.
if (typeof window !== 'undefined') {
  void setPersistence(auth, browserLocalPersistence);
}

const logger = createLogger('auth');

// ---------------------------------------------------------------------------
// Firebase Auth error → AppError mapping
// ---------------------------------------------------------------------------

/**
 * Map of Firebase Auth error codes to user-friendly messages.
 * Reference: https://firebase.google.com/docs/auth/admin/errors
 */
const AUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Phone auth
  'auth/invalid-phone-number':
    'The phone number is invalid. Include the country code, e.g. +91 98765 43210.',
  'auth/missing-phone-number': 'Please enter your phone number.',
  'auth/quota-exceeded': 'SMS quota exceeded. Please try again in a few minutes.',
  'auth/captcha-check-failed':
    'reCAPTCHA verification failed. Please refresh the page and try again.',
  'auth/invalid-verification-code': 'The OTP you entered is incorrect. Please check and try again.',
  'auth/code-expired': 'The OTP has expired. Please request a new code.',
  'auth/missing-verification-code': 'Please enter the OTP sent to your phone.',
  'auth/too-many-requests':
    'Too many sign-in attempts from this device. Please wait a few minutes and try again.',
  'auth/session-expired': 'Your sign-in session expired. Please request a new OTP.',
  // Google OAuth
  'auth/popup-closed-by-user': 'Sign-in was cancelled. Please try again.',
  'auth/popup-blocked':
    'The sign-in popup was blocked by your browser. Please allow popups for this site.',
  'auth/cancelled-popup-request': 'Another sign-in is already in progress.',
  'auth/account-exists-with-different-credential':
    'An account with this phone number already exists. Please sign in with your original method.',
  // General
  'auth/user-disabled': 'This account has been disabled. Please contact support.',
  'auth/network-request-failed':
    'Network error — please check your connection and try again.',
  'auth/internal-error': 'An internal authentication error occurred. Please try again.',
  'auth/web-storage-unsupported':
    'Your browser does not support web storage. Please enable cookies and try again.',
  'auth/operation-not-allowed':
    'This sign-in method is not enabled. Please contact support.',
  'auth/requires-recent-login':
    'For security, please sign in again before continuing.',
  'auth/user-token-expired': 'Your session has expired. Please sign in again.',
};

/**
 * Normalise a raw Firebase Auth error into a typed AppError with a
 * user-facing message and a machine-readable code.
 */
function normaliseAuthError(err: unknown, operation: string): AppError {
  if (err instanceof AppError) return err;

  const fbErr = err as Partial<FirebaseAuthError>;
  const code = fbErr.code ?? 'auth/internal-error';
  const userMessage = AUTH_ERROR_MESSAGES[code] ?? `Authentication failed. (${code})`;

  logger.error(operation, 'Firebase Auth error', {
    name: fbErr.name ?? 'FirebaseAuthError',
    message: fbErr.message ?? '',
    code,
  });

  // Preserve the original Firebase error code so the UI can display it.
  const appErr = new AppError(code, userMessage, 401);
  return appErr;
}

function normaliseLogError(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, code: (err as { code?: string }).code };
  }
  return { name: 'UnknownError', message: String(err) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// reCAPTCHA verifier singleton
// ---------------------------------------------------------------------------

let recaptchaVerifier: RecaptchaVerifier | null = null;

/**
 * Return the invisible reCAPTCHA verifier, creating it lazily.
 * The DOM container identified by `containerId` must exist before calling.
 * On expiry the singleton is cleared so the next call builds a fresh one.
 *
 * @param containerId  - DOM element ID for the invisible widget
 */
export function getRecaptchaVerifier(containerId: string): RecaptchaVerifier {
  if (recaptchaVerifier !== null) return recaptchaVerifier;

  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: 'invisible',
    callback: () => {
      logger.debug('recaptcha', 'reCAPTCHA challenge solved');
    },
    'expired-callback': () => {
      logger.warn('recaptcha', 'reCAPTCHA token expired — resetting verifier');
      resetRecaptchaVerifier();
    },
  });

  return recaptchaVerifier;
}

/**
 * Destroy the current reCAPTCHA verifier so the next `getRecaptchaVerifier`
 * call creates a fresh instance.
 *
 * Call after a failed OTP send — reusing a spent verifier token causes
 * `auth/captcha-check-failed` on the next attempt.
 */
export function resetRecaptchaVerifier(): void {
  if (recaptchaVerifier !== null) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // clear() throws if the widget DOM node was already removed — ignore.
    }
    recaptchaVerifier = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Begin the phone-number OTP sign-in flow.
 *
 * Firebase sends an SMS to `phoneNumber`.  Pass the returned `ConfirmationResult`
 * and the user-entered code to `verifyOTP` to complete sign-in.
 *
 * @param phoneNumber  - E.164 format, e.g. '+919876543210'
 * @param containerId  - DOM element ID for the invisible reCAPTCHA widget
 * @param ctx          - optional correlation / UID context for structured logging
 * @throws {AppError}  - user-facing message on every failure mode
 */
export async function signInWithPhone(
  phoneNumber: string,
  containerId: string,
  ctx?: LogContext,
): Promise<ConfirmationResult> {
  logger.info(
    'signInWithPhone',
    'sending OTP',
    { phonePrefix: phoneNumber.slice(0, 6) + '…' },
    ctx,
  );

  try {
    const verifier = getRecaptchaVerifier(containerId);
    const result = await signInWithPhoneNumber(auth, phoneNumber, verifier);
    logger.info('signInWithPhone', 'OTP sent successfully', undefined, ctx);
    return result;
  } catch (err) {
    // Reset so the user can retry without a stale verifier.
    resetRecaptchaVerifier();
    throw normaliseAuthError(err, 'signInWithPhone');
  }
}

/**
 * Verify the 6-digit OTP the user received by SMS.
 *
 * @param confirmationResult  - value returned by `signInWithPhone`
 * @param otp                 - 6-digit code from the SMS
 * @param ctx                 - optional logging context
 * @throws {AppError}
 */
export async function verifyOTP(
  confirmationResult: ConfirmationResult,
  otp: string,
  ctx?: LogContext,
): Promise<UserCredential> {
  logger.info('verifyOTP', 'confirming OTP', undefined, ctx);
  try {
    const credential = await confirmationResult.confirm(otp);
    logger.info('verifyOTP', 'OTP accepted', { uid: credential.user.uid }, ctx);
    return credential;
  } catch (err) {
    throw normaliseAuthError(err, 'verifyOTP');
  }
}

/**
 * Sign in with Google OAuth.
 * Opens a popup — the browser must allow popups for this origin.
 *
 * @param ctx  - optional logging context
 * @throws {AppError}
 */
export async function signInWithGoogle(ctx?: LogContext): Promise<UserCredential> {
  logger.info('signInWithGoogle', 'opening popup', undefined, ctx);
  try {
    const provider = new GoogleAuthProvider();
    // Always show the account chooser, even if the user is already signed in.
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth, provider);
    logger.info('signInWithGoogle', 'signed in', { uid: credential.user.uid }, ctx);
    return credential;
  } catch (err) {
    throw normaliseAuthError(err, 'signInWithGoogle');
  }
}

/**
 * Sign out the current user from Firebase Auth and clear the server session.
 *
 * Network failure on the server DELETE is swallowed — the local sign-out
 * always succeeds and the server cookie expires naturally after 14 days.
 *
 * @param ctx  - optional logging context
 */
export async function signOut(ctx?: LogContext): Promise<void> {
  logger.info('signOut', 'signing out', undefined, ctx);

  try {
    await firebaseSignOut(auth);
  } catch (err) {
    logger.warn('signOut', 'Firebase signOut threw — continuing', normaliseLogError(err), undefined, ctx);
  }

  // Best-effort server-side cookie revocation.
  try {
    await fetch('/api/auth/session', { method: 'DELETE' });
  } catch {
    // Ignore — the cookie has a 14-day expiry.
  }

  logger.info('signOut', 'signed out', undefined, ctx);
}

/**
 * Return the currently signed-in Firebase user, or `null` if unauthenticated.
 *
 * This is a synchronous read from the in-memory Auth state snapshot.
 * For reactive use, subscribe via `onAuthStateChanged` instead.
 */
export function getCurrentUser(): User | null {
  return auth.currentUser;
}

/**
 * Subscribe to Firebase Auth state changes.
 *
 * The callback fires immediately with the current user (or null), then on
 * every subsequent sign-in or sign-out event.
 *
 * @returns Unsubscribe function — call on component unmount to prevent leaks.
 *
 * @example
 * useEffect(() => onAuthStateChanged((u) => setUser(u)), []);
 */
export function onAuthStateChanged(callback: (user: User | null) => void): Unsubscribe {
  return firebaseOnAuthStateChanged(auth, callback);
}

/**
 * Get the current user's Firebase ID token (JWT).
 *
 * Firebase tokens expire after 1 hour and are refreshed automatically.
 * Pass `forceRefresh: true` immediately before `setSessionCookie` to ensure
 * the token is fresh when the server verifies it.
 *
 * @param forceRefresh  - force a network refresh regardless of token expiry
 * @param ctx           - optional logging context
 * @throws {AuthError}  - when there is no authenticated user
 * @throws {AppError}   - on token refresh failure
 */
export async function getIdToken(forceRefresh = false, ctx?: LogContext): Promise<string> {
  const user = auth.currentUser;
  if (user === null) {
    logger.warn('getIdToken', 'called without an authenticated user', undefined, undefined, ctx);
    throw new AuthError('You must be signed in to continue.');
  }

  try {
    const token = await user.getIdToken(forceRefresh);
    logger.debug('getIdToken', 'token retrieved', { forceRefresh }, ctx);
    return token;
  } catch (err) {
    throw normaliseAuthError(err, 'getIdToken');
  }
}

/**
 * Exchange a fresh Firebase ID token for a server-side HttpOnly session cookie.
 *
 * Must be called immediately after every successful sign-in.  The server
 * cookie is what Next.js middleware uses to gate protected routes.
 *
 * Retries once after a 1-second delay on transient network failures —
 * relevant in 2G flood zones where the sign-in network bounce is unreliable.
 *
 * @param idToken  - fresh token from `getIdToken(true)`
 * @param ctx      - optional logging context
 * @throws {AppError}  on persistent failure
 */
export async function setSessionCookie(idToken: string, ctx?: LogContext): Promise<void> {
  const requestId = crypto.randomUUID();
  logger.info('setSessionCookie', 'creating server session', { requestId }, ctx);

  const doRequest = (): Promise<Response> =>
    fetch('/api/auth/session', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });

  let response: Response;
  try {
    response = await doRequest();
  } catch {
    // First attempt failed (network error) — wait 1 s and retry once.
    logger.warn('setSessionCookie', 'first attempt failed — retrying', undefined, undefined, ctx);
    await sleep(1_000);
    try {
      response = await doRequest();
    } catch (retryErr) {
      logger.error(
        'setSessionCookie',
        'both attempts failed',
        normaliseLogError(retryErr),
        { requestId },
        ctx,
      );
      throw new AppError(
        'UPSTREAM_ERROR',
        'Could not establish a session. Please check your connection and try again.',
        503,
      );
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.error(
      'setSessionCookie',
      `server returned ${response.status}`,
      { name: 'SessionError', message: body },
      { requestId, status: response.status },
      ctx,
    );
    throw new AppError(
      'UPSTREAM_ERROR',
      'Failed to create session. Please try signing in again.',
      response.status,
    );
  }

  logger.info('setSessionCookie', 'session cookie created', { requestId }, ctx);
}
