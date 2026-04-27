/**
 * Firebase client SDK singleton.
 *
 * Rules:
 *  1. Only one FirebaseApp is ever initialised — `getApps()` guards against
 *     double-init caused by Next.js hot-module replacement in development.
 *  2. Environment-variable validation is deferred to the first import that
 *     runs in the browser so that SSR (where NEXT_PUBLIC_* vars are always
 *     present in the build) never throws during server rendering.
 *  3. The `firebaseConfig` object is exported so Firebase Analytics and
 *     Performance Monitoring can be initialised lazily (client-only, after
 *     user consent) without re-reading env vars.
 *
 * Usage:
 *   import { firebaseApp } from '@/lib/firebase/client';
 */

import { initializeApp, getApps, getApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';

// ---------------------------------------------------------------------------
// Env-var validation
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Typed Firebase configuration object built from environment variables.
 * Exported so that Analytics / Performance Monitoring modules can initialise
 * from the same config without re-reading `process.env`.
 */
// Next.js only inlines NEXT_PUBLIC_* vars when accessed as literal strings —
// dynamic key access (process.env[variable]) returns undefined in the browser.
const _apiKey            = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const _authDomain        = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
const _projectId         = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const _storageBucket     = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const _messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
const _appId             = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
const _databaseURL       = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;
const _measurementId     = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;

function assertEnv(value: string | undefined, key: string): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `[Firebase] Missing required environment variable "${key}".\n` +
        `  → Copy .env.example to apps/web/.env.local and fill in all values.\n` +
        `  → See RAHATNET_ENGINEERING_BIBLE.md §3 for Firebase Console setup.`,
    );
  }
  return value;
}

export const firebaseConfig: FirebaseOptions = {
  apiKey:            assertEnv(_apiKey,            'NEXT_PUBLIC_FIREBASE_API_KEY'),
  authDomain:        assertEnv(_authDomain,        'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'),
  projectId:         assertEnv(_projectId,         'NEXT_PUBLIC_FIREBASE_PROJECT_ID'),
  storageBucket:     assertEnv(_storageBucket,     'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: assertEnv(_messagingSenderId, 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
  appId:             assertEnv(_appId,             'NEXT_PUBLIC_FIREBASE_APP_ID'),
  measurementId:     _measurementId,
  databaseURL:       assertEnv(_databaseURL,       'NEXT_PUBLIC_FIREBASE_DATABASE_URL'),
} as const;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/**
 * The single FirebaseApp instance for the client.
 *
 * `getApps()` returns the list of already-initialised apps.  If one exists
 * (e.g. from a previous HMR cycle), we reuse it with `getApp()` rather than
 * calling `initializeApp` again — double-init throws in Firebase 10+.
 */
export const firebaseApp: FirebaseApp =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
