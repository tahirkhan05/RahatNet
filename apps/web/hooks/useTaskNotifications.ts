'use client';

/**
 * useTaskNotifications — FCM push notification integration for volunteers.
 *
 * Handles three notification channels:
 *
 *  1. Foreground messages (app open)
 *     Firebase `onMessage` fires when the app is in the foreground.
 *     TASK_ASSIGNED → surfaces the TaskAcceptModal via `pendingAssignment` state.
 *     Other types → dispatched as toast callbacks.
 *
 *  2. Background messages / notification clicks (SW)
 *     The service worker posts a `NOTIFICATION_CLICK` message to the window.
 *     We listen for it and navigate or show the modal accordingly.
 *
 *  3. Token registration
 *     Calls `getToken` with the VAPID key on first mount.
 *     If the token changes (device rotation, re-install), it is re-POSTed
 *     to /api/auth/fcm-token so the server has the latest.
 *
 * The hook does NOT manage the SW push handler (that lives in public/sw.js).
 * This hook only handles the React / client-side side of the integration.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CanonicalNeed } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingTaskAssignment {
  readonly assignmentId: string;
  readonly need:         CanonicalNeed;
  readonly message:      string;
  readonly estimatedMinutes: number;
}

export interface UseTaskNotificationsReturn {
  /**
   * Set when a TASK_ASSIGNED notification is received while the app is open.
   * Clear it (set to null) when the volunteer accepts or declines.
   */
  readonly pendingAssignment:    PendingTaskAssignment | null;
  readonly clearPendingAssignment: () => void;
  /** True while the FCM token is being registered. */
  readonly isRegistering:        boolean;
  /** Non-null when FCM registration failed. */
  readonly registrationError:    string | null;
}

// ---------------------------------------------------------------------------
// FCM message payload shape (must match sw.js push handler)
// ---------------------------------------------------------------------------

interface FcmPayload {
  type:           string;
  assignmentId?:  string;
  needId?:        string;
  needType?:      string;
  locationName?:  string;
  message?:       string;
  status?:        string;
  reportId?:      string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseTaskNotificationsOptions {
  /** Firebase Auth UID — used to POST the FCM token to the backend. */
  uid:           string | null;
  /** Called when any non-assignment push notification arrives. */
  onToast?:      (message: string) => void;
  /** Called when navigating from a notification click. */
  onNavigate?:   (url: string) => void;
}

export function useTaskNotifications({
  uid,
  onToast,
  onNavigate,
}: UseTaskNotificationsOptions): UseTaskNotificationsReturn {
  const [pendingAssignment, setPendingAssignment] = useState<PendingTaskAssignment | null>(null);
  const [isRegistering,    setIsRegistering]     = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  const lastTokenRef = useRef<string | null>(null);

  // ── FCM token registration ────────────────────────────────────────────────

  useEffect(() => {
    if (!uid) return;

    void (async () => {
      setIsRegistering(true);
      setRegistrationError(null);

      try {
        const { getMessaging, getToken } = await import('firebase/messaging');
        const { firebaseApp }            = await import('@/lib/firebase/client');

        const vapidKey = process.env['NEXT_PUBLIC_FCM_VAPID_KEY'];
        if (!vapidKey) {
          setRegistrationError('FCM VAPID key not configured');
          return;
        }

        // FCM requires a service worker.
        if (!('serviceWorker' in navigator)) return;
        const swReg = await navigator.serviceWorker.ready;

        const messaging = getMessaging(firebaseApp);
        const token     = await getToken(messaging, { vapidKey, serviceWorkerRegistration: swReg });

        if (token && token !== lastTokenRef.current) {
          lastTokenRef.current = token;
          // Persist to backend so the server can send notifications.
          await fetch('/api/auth/fcm-token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ token }),
          }).catch(() => undefined);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'FCM registration failed';
        setRegistrationError(msg);
      } finally {
        setIsRegistering(false);
      }
    })();
  }, [uid]);

  // ── Foreground message listener ───────────────────────────────────────────

  useEffect(() => {
    if (!uid) return;

    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { getMessaging, onMessage } = await import('firebase/messaging');
        const { firebaseApp }             = await import('@/lib/firebase/client');
        const messaging                   = getMessaging(firebaseApp);

        unsubscribe = onMessage(messaging, (payload) => {
          const data = (payload.data ?? {}) as unknown as FcmPayload;
          handleFcmMessage(data);
        });
      } catch {
        // FCM may not be available on all platforms (e.g. Safari < 16.4).
      }
    })();

    return () => unsubscribe?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // ── SW → app message bridge (NOTIFICATION_CLICK, REPORT_SYNCED) ──────────

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handler = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const msg = event.data as { type: string; url?: string; data?: FcmPayload };

      if (msg.type === 'NOTIFICATION_CLICK' && msg.url) {
        onNavigate?.(msg.url);
        // If this was a task assignment link, also surface the modal.
        if (msg.data?.type === 'TASK_ASSIGNED' && msg.data.assignmentId) {
          handleFcmMessage(msg.data);
        }
      }
    };

    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNavigate]);

  // ── Message dispatcher ────────────────────────────────────────────────────

  const handleFcmMessage = useCallback((data: FcmPayload) => {
    switch (data.type) {
      case 'TASK_ASSIGNED': {
        if (!data.assignmentId || !data.needId) break;

        // Fetch the full need from Firestore so the modal has complete data.
        void (async () => {
          try {
            const { getDocument }     = await import('@/lib/firebase/firestore');
            const { COLLECTIONS }     = await import('@rahatnet/types');
            const need = await getDocument(COLLECTIONS.NEEDS, data.needId as string);
            if (need) {
              setPendingAssignment({
                assignmentId:      data.assignmentId as string,
                need:              need as import('@rahatnet/types').CanonicalNeed,
                message:           data.message ?? 'You have been assigned a task.',
                estimatedMinutes:  0, // computed in TaskAcceptModal via distance
              });
            }
          } catch {
            // Fallback: surface a generic notification without full need data.
            onToast?.('New task assigned — tap to view details.');
          }
        })();
        break;
      }

      case 'REPORT_UPDATE':
        onToast?.(`Report status updated: ${data.status ?? 'Updated'}`);
        break;

      case 'DISASTER_ALERT':
        onToast?.('New disaster alert. Check your task list.');
        break;

      default:
        if (data.message) onToast?.(data.message);
        break;
    }
  }, [onToast]);

  const clearPendingAssignment = useCallback(() => {
    setPendingAssignment(null);
  }, []);

  return {
    pendingAssignment,
    clearPendingAssignment,
    isRegistering,
    registrationError,
  };
}
