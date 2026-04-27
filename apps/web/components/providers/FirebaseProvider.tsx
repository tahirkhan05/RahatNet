'use client';

/**
 * FirebaseProvider initialises the Firebase client SDK once at the top of the
 * React tree.  Importing `firebaseApp` from `@/lib/firebase/client` is enough
 * to trigger initialisation, but we do it here explicitly so:
 *
 *  1. The error surface is a single, visible React boundary rather than a
 *     cryptic module-level throw.
 *  2. Children can safely import the singleton without worrying about order.
 *
 * This component renders nothing of its own — it is purely a lifecycle hook.
 */

import * as React from 'react';

interface FirebaseProviderProps {
  children: React.ReactNode;
}

interface FirebaseContextValue {
  /** True once the Firebase SDK has been initialised without errors. */
  readonly isReady: boolean;
  /** Non-null when initialisation threw (e.g. missing env vars in dev). */
  readonly initError: Error | null;
}

const FirebaseContext = React.createContext<FirebaseContextValue>({
  isReady: false,
  initError: null,
});

/** Read the Firebase initialisation state anywhere in the tree. */
export function useFirebase(): FirebaseContextValue {
  return React.useContext(FirebaseContext);
}

export function FirebaseProvider({ children }: FirebaseProviderProps) {
  const [isReady, setIsReady] = React.useState(false);
  const [initError, setInitError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    /**
     * Dynamic import so the Firebase SDK is never included in the SSR bundle.
     * The client-side module calls `initializeApp` on first import and throws
     * if any required env vars are absent.
     */
    import('@/lib/firebase/client')
      .then(() => setIsReady(true))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[FirebaseProvider] SDK initialisation failed:', error.message);
        setInitError(error);
      });
  }, []);

  return (
    <FirebaseContext.Provider value={{ isReady, initError }}>
      {children}
    </FirebaseContext.Provider>
  );
}
