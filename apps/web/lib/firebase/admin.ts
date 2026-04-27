/**
 * Firebase Admin SDK — server-side singleton.
 *
 * Only imported in:
 *   - Next.js API routes (Node.js runtime, never Edge)
 *   - Firebase Cloud Functions (apps/functions/)
 *   - Seed scripts (scripts/)
 *
 * Never import this file from a client component or anything under 'use client'.
 *
 * Singleton pattern:
 *   `initializeApp` throws if called a second time with the same app name.
 *   We guard with `getApps()` so that Next.js module hot-reload in development
 *   and parallel Vitest workers both get the same instance.
 *
 * Service account:
 *   Stored as a base64-encoded JSON string in FIREBASE_SERVICE_ACCOUNT_BASE64.
 *   Encoding: `cat service-account.json | base64 | tr -d '\n'`
 *   The JSON is validated against required fields before `cert()` is called
 *   so misconfigured deployments fail fast with a clear error message.
 *
 * FCM batching:
 *   `sendEachForMulticast` (Firebase Admin 12+) sends one FCM request per
 *   token and returns individual results.  We batch in groups of 500 (FCM
 *   multicast limit) and collect partial-success / failure stats.
 */

import { initializeApp, getApps, getApp, cert, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';
import {
  getMessaging,
  type Messaging,
  type MulticastMessage,
  type TopicMessage,
} from 'firebase-admin/messaging';
import { UserRole } from '@rahatnet/types';
import { createServerLogger, toLogError } from '@/lib/api/serverLogger';
import { AppError } from '@/lib/utils/errors';

const logger = createServerLogger('admin');

// ---------------------------------------------------------------------------
// Service account validation
// ---------------------------------------------------------------------------

const REQUIRED_SA_FIELDS = [
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
] as const;

type ServiceAccountField = (typeof REQUIRED_SA_FIELDS)[number];

interface RawServiceAccount {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
}

function parseServiceAccount(): ServiceAccount {
  const encoded = process.env['FIREBASE_SERVICE_ACCOUNT_BASE64'];

  if (!encoded || encoded.trim() === '') {
    throw new Error(
      '[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.\n' +
        '  → Run: cat service-account.json | base64 | tr -d "\\n"\n' +
        '  → Paste the output into your .env.local file.',
    );
  }

  let raw: RawServiceAccount;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) as RawServiceAccount;
  } catch {
    throw new Error(
      '[Firebase Admin] FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON.\n' +
        '  → Re-encode the service account file and update your .env.local.',
    );
  }

  const missingFields = REQUIRED_SA_FIELDS.filter(
    (f: ServiceAccountField) => !raw[f] || (raw[f] as string).trim() === '',
  );

  if (missingFields.length > 0) {
    throw new Error(
      `[Firebase Admin] Service account JSON is missing required fields: ${missingFields.join(', ')}.\n` +
        '  → Download a fresh service account key from Firebase Console → Project Settings → Service Accounts.',
    );
  }

  return raw as unknown as ServiceAccount;
}

// ---------------------------------------------------------------------------
// App singleton
// ---------------------------------------------------------------------------

const APP_NAME = 'rahatnet-admin';

function createOrGetAdminApp(): App {
  // Check by name so the default app used by firebase-admin in Cloud Functions
  // does not conflict with the named app we create here.
  try {
    return getApp(APP_NAME);
  } catch {
    // App not yet initialised — create it.
  }

  if (getApps().length === 0) {
    // First-ever initialisation.
    return initializeApp(
      {
        credential: cert(parseServiceAccount()),
        storageBucket: process.env['NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'],
        databaseURL: process.env['NEXT_PUBLIC_FIREBASE_DATABASE_URL'],
      },
      APP_NAME,
    );
  }

  // A default (unnamed) app already exists — initialise our named app.
  return initializeApp(
    {
      credential: cert(parseServiceAccount()),
      storageBucket: process.env['NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'],
      databaseURL: process.env['NEXT_PUBLIC_FIREBASE_DATABASE_URL'],
    },
    APP_NAME,
  );
}

const adminApp: App = createOrGetAdminApp();

// ---------------------------------------------------------------------------
// Service exports
// ---------------------------------------------------------------------------

/** Firebase Admin Auth — token verification, user management, custom claims. */
export const adminAuth: Auth = getAuth(adminApp);

/** Firebase Admin Firestore — server-side reads and writes (no client SDK). */
export const adminFirestore: Firestore = getFirestore(adminApp);

/** Firebase Admin Storage — signed URL generation and server-side file ops. */
export const adminStorage: Storage = getStorage(adminApp);

/** Firebase Admin Messaging — FCM push notification dispatch. */
export const adminMessaging: Messaging = getMessaging(adminApp);

// ---------------------------------------------------------------------------
// Notification payload type
// ---------------------------------------------------------------------------

/**
 * Push notification payload sent via FCM.
 *
 * `title` and `body` are displayed in the system notification shade.
 * `data` is passed to the app (SW push handler / foreground message listener)
 * and is invisible to the end user.
 *
 * All values in `data` must be strings (FCM requirement).
 */
export interface NotificationPayload {
  /** Notification title — shown in the OS notification shade. */
  readonly title: string;
  /** Notification body — shown beneath the title. */
  readonly body: string;
  /**
   * Custom key-value data delivered to the app.
   * All values must be strings.  Clients receive this in
   * `event.data` inside the service worker's `push` handler.
   */
  readonly data?: Readonly<Record<string, string>>;
  /**
   * Deep-link URL opened when the user taps the notification.
   * Should be a path-only URL, e.g. '/volunteer/tasks?assignment=abc'.
   */
  readonly clickUrl?: string;
  /**
   * Android notification channel ID.
   * Must match a channel registered by the Flutter / PWA app.
   * Defaults to 'default' when omitted.
   */
  readonly androidChannelId?: string;
  /**
   * Badge count to show on the app icon (iOS / Android).
   * Pass 0 to clear the badge.
   */
  readonly badge?: number;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Cryptographically verify a Firebase session cookie.
 *
 * Checks the cookie's signature, expiry, and that the token has not been
 * revoked (revocation check contacts the Firebase Auth service).
 *
 * @param cookie    - the raw cookie value from the `rahatnet_session` cookie
 * @param ctx       - optional request ID for log correlation
 * @returns Decoded token with UID and custom claims
 * @throws {AppError} AUTH_REQUIRED when the cookie is invalid or revoked
 */
export async function verifySessionCookie(
  cookie: string,
  ctx?: { requestId?: string },
): Promise<DecodedIdToken> {
  try {
    // `checkRevoked: true` makes a network call to Firebase Auth to verify the
    // token has not been revoked.  This adds ~50 ms but is essential for
    // instant revocation on sign-out or account suspension.
    return await adminAuth.verifySessionCookie(cookie, /* checkRevoked */ true);
  } catch (err) {
    logger.warn(
      'verifySessionCookie',
      'session cookie invalid or revoked',
      toLogError(err),
      undefined,
      ctx,
    );
    throw new AppError('AUTH_REQUIRED', 'Your session has expired. Please sign in again.', 401);
  }
}

/**
 * Create a server-side Firebase session cookie from a fresh ID token.
 *
 * Firebase session cookies are opaque tokens that can be verified without
 * contacting Firebase Auth on every request (the signature is verified
 * locally, revocation checked on logout or `verifySessionCookie`).
 *
 * @param idToken    - fresh Firebase ID token (obtained from `getIdToken(true)` on the client)
 * @param expiresIn  - cookie lifetime in milliseconds (max 14 days = 1,209,600,000 ms)
 * @returns Encoded session cookie string
 * @throws {AppError} INVALID_TOKEN when the ID token is invalid
 */
export async function createSessionCookie(
  idToken: string,
  expiresIn: number,
  ctx?: { requestId?: string },
): Promise<string> {
  try {
    return await adminAuth.createSessionCookie(idToken, { expiresIn });
  } catch (err) {
    logger.error(
      'createSessionCookie',
      'failed to create session cookie',
      toLogError(err),
      undefined,
      ctx,
    );
    throw new AppError('INVALID_TOKEN', 'The sign-in token is invalid or expired.', 401);
  }
}

/**
 * Revoke all Firebase refresh tokens for a user.
 *
 * Called on sign-out to ensure that all existing sessions are immediately
 * invalidated.  Existing ID tokens remain valid until they expire (1 hour)
 * unless `verifySessionCookie` is called with `checkRevoked: true`.
 *
 * @param uid  - Firebase Auth UID
 * @param ctx  - optional request ID for log correlation
 */
export async function revokeRefreshTokens(
  uid: string,
  ctx?: { requestId?: string },
): Promise<void> {
  try {
    await adminAuth.revokeRefreshTokens(uid);
    logger.info('revokeRefreshTokens', 'tokens revoked', { uid: uid.slice(0, 8) + '…' }, ctx);
  } catch (err) {
    // Log but don't throw — the session cookie is cleared regardless.
    logger.warn(
      'revokeRefreshTokens',
      'failed to revoke tokens — session cookie will expire naturally',
      toLogError(err),
      { uid: uid.slice(0, 8) + '…' },
      ctx,
    );
  }
}

// ---------------------------------------------------------------------------
// Role / custom claims
// ---------------------------------------------------------------------------

/**
 * Set the application role as a Firebase Auth custom claim.
 *
 * Custom claims are included in every ID token and session cookie so the
 * middleware can read the role without a Firestore query.  The claim is
 * also written to Firestore (by the calling route handler) as the source
 * of truth.
 *
 * Important: custom claims take effect in the NEXT token refresh.  The
 * client must call `getIdToken(true)` and then `setSessionCookie` after
 * a role change for the new role to appear in the cookie immediately.
 *
 * @param uid   - Firebase Auth UID
 * @param role  - the new UserRole to assign
 * @param ctx   - optional request ID for log correlation
 * @throws {AppError} INTERNAL_ERROR on Firebase Admin failure
 */
export async function setUserRole(
  uid: string,
  role: UserRole,
  ctx?: { requestId?: string },
): Promise<void> {
  logger.info('setUserRole', 'setting role', { uid: uid.slice(0, 8) + '…', role }, ctx);
  try {
    // Preserve any existing custom claims not related to role.
    const user = await adminAuth.getUser(uid);
    const existingClaims = (user.customClaims as Record<string, unknown> | undefined) ?? {};

    await adminAuth.setCustomUserClaims(uid, {
      ...existingClaims,
      role,
    });

    logger.info('setUserRole', 'role set', { uid: uid.slice(0, 8) + '…', role }, ctx);
  } catch (err) {
    logger.error(
      'setUserRole',
      'failed to set custom claim',
      toLogError(err),
      { uid: uid.slice(0, 8) + '…', role },
      ctx,
    );
    throw new AppError(
      'INTERNAL_ERROR',
      'Failed to update user role. Please try again.',
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// FCM push notifications
// ---------------------------------------------------------------------------

/** Maximum tokens per FCM `sendEachForMulticast` call. */
const FCM_BATCH_SIZE = 500;

export interface SendNotificationResult {
  /** Total tokens the notification was sent to. */
  readonly successCount: number;
  /** Tokens that failed — may include invalid tokens to be pruned. */
  readonly failureCount: number;
  /** Token-specific errors for caller to handle (e.g. remove invalid tokens). */
  readonly failedTokens: readonly string[];
}

/**
 * Send a push notification to one or more device tokens.
 *
 * Tokens are sent in batches of 500 (FCM multicast limit).  Within each
 * batch, `sendEachForMulticast` sends one HTTP request per token and returns
 * per-token results so failures don't block successes.
 *
 * Invalid tokens (codes: `messaging/invalid-registration-token`,
 * `messaging/registration-token-not-registered`) are collected in
 * `failedTokens` so callers can remove them from their database.
 *
 * @param tokens   - array of FCM registration tokens
 * @param payload  - notification content
 * @param ctx      - optional request ID for log correlation
 * @throws {AppError} FCM_ERROR when ALL batches fail (partial success is not an error)
 */
export async function sendPushNotification(
  tokens: readonly string[],
  payload: NotificationPayload,
  ctx?: { requestId?: string },
): Promise<SendNotificationResult> {
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, failedTokens: [] };
  }

  logger.info('sendPushNotification', 'sending', { tokenCount: tokens.length }, ctx);

  let totalSuccess = 0;
  let totalFailure = 0;
  const failedTokens: string[] = [];
  let allBatchesFailed = true;

  // Split into batches of 500.
  for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
    const batchTokens = tokens.slice(i, i + FCM_BATCH_SIZE);

    const message: MulticastMessage = {
      tokens: batchTokens as string[],
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: {
        ...payload.data,
        ...(payload.clickUrl != null ? { clickUrl: payload.clickUrl } : {}),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: payload.androidChannelId ?? 'default',
          ...(payload.badge != null ? { notificationCount: payload.badge } : {}),
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            ...(payload.badge != null ? { badge: payload.badge } : {}),
          },
        },
      },
      webpush: {
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.badge != null ? { badge: String(payload.badge) } : {}),
        },
        ...(payload.clickUrl != null
          ? { fcmOptions: { link: payload.clickUrl } }
          : {}),
      },
    };

    try {
      const batchResponse = await adminMessaging.sendEachForMulticast(message);
      allBatchesFailed = false;
      totalSuccess += batchResponse.successCount;
      totalFailure += batchResponse.failureCount;

      batchResponse.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code ?? '';
          const isInvalidToken =
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered';

          if (isInvalidToken) {
            failedTokens.push(batchTokens[idx] ?? '');
          }

          logger.warn(
            'sendPushNotification',
            `token ${idx} in batch failed`,
            toLogError(resp.error),
            { batchStart: i, tokenIndex: idx, code },
            ctx,
          );
        }
      });
    } catch (err) {
      // Entire batch call failed — log but continue with remaining batches.
      logger.error(
        'sendPushNotification',
        `batch starting at ${i} failed entirely`,
        toLogError(err),
        { batchStart: i, batchSize: batchTokens.length },
        ctx,
      );
      totalFailure += batchTokens.length;
    }
  }

  if (allBatchesFailed) {
    throw new AppError(
      'FCM_ERROR',
      'Failed to send push notifications. Please try again.',
      503,
    );
  }

  logger.info('sendPushNotification', 'completed', { totalSuccess, totalFailure }, ctx);

  return {
    successCount: totalSuccess,
    failureCount: totalFailure,
    failedTokens,
  };
}

/**
 * Send a push notification to a named FCM topic.
 *
 * Topics allow targeting a group of devices that have subscribed without
 * managing individual tokens.  RahatNet uses topics for district-level
 * disaster alerts: e.g. `district-Ernakulam`.
 *
 * @param topic    - FCM topic name (without leading `/topics/`)
 * @param payload  - notification content
 * @param ctx      - optional request ID for log correlation
 * @throws {AppError} FCM_ERROR on failure
 */
export async function sendTopicNotification(
  topic: string,
  payload: NotificationPayload,
  ctx?: { requestId?: string },
): Promise<void> {
  // FCM topic names must match [a-zA-Z0-9-_.~%]+
  if (!/^[a-zA-Z0-9\-_.~%]+$/.test(topic)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Invalid FCM topic name: "${topic}". Only alphanumeric and -_.~% characters are allowed.`,
      400,
    );
  }

  logger.info('sendTopicNotification', 'sending', { topic }, ctx);

  const message: TopicMessage = {
    topic,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: {
      ...payload.data,
      ...(payload.clickUrl != null ? { clickUrl: payload.clickUrl } : {}),
    },
    android: {
      priority: 'high',
      notification: {
        channelId: payload.androidChannelId ?? 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          ...(payload.badge != null ? { badge: payload.badge } : {}),
        },
      },
    },
    webpush: {
      notification: {
        title: payload.title,
        body: payload.body,
      },
      ...(payload.clickUrl != null
        ? { fcmOptions: { link: payload.clickUrl } }
        : {}),
    },
  };

  try {
    const messageId = await adminMessaging.send(message);
    logger.info('sendTopicNotification', 'sent', { topic, messageId }, ctx);
  } catch (err) {
    logger.error(
      'sendTopicNotification',
      'failed to send topic notification',
      toLogError(err),
      { topic },
      ctx,
    );
    throw new AppError(
      'FCM_ERROR',
      `Failed to send notification to topic "${topic}". Please try again.`,
      503,
    );
  }
}
