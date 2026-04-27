'use client';

/**
 * useServiceWorker — manages the SW lifecycle and app↔SW message bridge.
 *
 * Responsibilities:
 *
 *  1. Registration
 *     Registers /sw.js on first mount (production only — disabled in dev by
 *     next-pwa).  Passes the registration object to callers via `registration`.
 *
 *  2. Update detection
 *     Watches for a "waiting" service worker (new build deployed while the
 *     user has the app open).  Sets `updateAvailable: true` so the app can
 *     show a "New version available — reload" prompt (SwUpdateBanner).
 *
 *  3. Skip-waiting
 *     `applyUpdate()` posts SKIP_WAITING to the waiting SW, then reloads
 *     the page once the new SW has activated.
 *
 *  4. Message routing
 *     Listens for SW → app messages and fires typed callbacks:
 *       NOTIFICATION_CLICK → `onNotificationClick(url, data)`
 *       REPORT_SYNCED      → `onReportSynced(reportId)`
 *       SW_VERSION         → resolves the `getVersion()` promise
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SWNotificationData {
  type:          string;
  url:           string;
  assignmentId?: string;
  reportId?:     string;
  [key: string]: unknown;
}

export interface UseServiceWorkerOptions {
  /** Called when the user taps a notification. Navigate to `url`. */
  onNotificationClick?: (url: string, data: SWNotificationData) => void;
  /** Called when a queued report is successfully synced from the SW. */
  onReportSynced?: (reportId: string) => void;
}

export interface UseServiceWorkerReturn {
  /** True when the SW is registered and controlling this page. */
  readonly isRegistered: boolean;
  /** True when a new SW version is waiting to activate. */
  readonly updateAvailable: boolean;
  /** Apply the waiting update: skip-waiting + reload. */
  readonly applyUpdate: () => void;
  /** Ask the SW for its version string (resolves async). */
  readonly getVersion: () => Promise<string>;
  /** The raw ServiceWorkerRegistration, or null before registration. */
  readonly registration: ServiceWorkerRegistration | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useServiceWorker({
  onNotificationClick,
  onReportSynced,
}: UseServiceWorkerOptions = {}): UseServiceWorkerReturn {
  const [isRegistered,    setIsRegistered]    = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [registration,    setRegistration]    = useState<ServiceWorkerRegistration | null>(null);

  // Stable refs so the effect closures don't need to re-run when callbacks change.
  const onNotificationClickRef = useRef(onNotificationClick);
  const onReportSyncedRef      = useRef(onReportSynced);
  useEffect(() => { onNotificationClickRef.current = onNotificationClick; }, [onNotificationClick]);
  useEffect(() => { onReportSyncedRef.current      = onReportSynced;      }, [onReportSynced]);

  // ── Registration + update detection ────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // next-pwa disables the SW in development — no point registering.
    if (process.env.NODE_ENV !== 'production') return;

    let reg: ServiceWorkerRegistration | null = null;

    const handleStateChange = () => {
      // A waiting SW just became active — the page is now controlled.
      if (reg?.active != null) setIsRegistered(true);
    };

    const handleUpdateFound = () => {
      const newWorker = reg?.installing;
      if (newWorker == null) return;

      newWorker.addEventListener('statechange', () => {
        // A new SW has installed and is waiting for the old one to release.
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller != null) {
          setUpdateAvailable(true);
        }
      });
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((r) => {
        reg = r;
        setRegistration(r);

        // Already active (page reload after activation).
        if (r.active != null) setIsRegistered(true);

        // Waiting SW detected on initial load (e.g. background update).
        if (r.waiting != null) setUpdateAvailable(true);

        r.addEventListener('updatefound', handleUpdateFound);

        // Poll for updates every 60 s so long-lived sessions pick up new deployments.
        const pollId = setInterval(() => void r.update(), 60_000);

        return () => {
          clearInterval(pollId);
          r.removeEventListener('updatefound', handleUpdateFound);
        };
      })
      .catch((err: unknown) => {
        console.error('[SW] Registration failed:', err);
      });

    // When the SW activates (possibly after claiming), mark as registered.
    navigator.serviceWorker.addEventListener('controllerchange', handleStateChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleStateChange);
    };
  }, []);

  // ── SW → app message routing ───────────────────────────────────────────────

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const msg = event.data as { type: string; [key: string]: unknown };

      switch (msg.type) {
        case 'NOTIFICATION_CLICK': {
          const url  = String(msg['url']  ?? '/');
          const data = (msg['data'] ?? {}) as SWNotificationData;
          onNotificationClickRef.current?.(url, data);
          break;
        }
        case 'REPORT_SYNCED': {
          const reportId = String(msg['reportId'] ?? '');
          if (reportId.length > 0) onReportSyncedRef.current?.(reportId);
          break;
        }
        default:
          break;
      }
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  // ── applyUpdate ────────────────────────────────────────────────────────────

  const applyUpdate = useCallback(() => {
    const waiting = registration?.waiting;
    if (waiting == null) return;

    // Tell the waiting SW to skip its waiting phase and activate.
    waiting.postMessage({ type: 'SKIP_WAITING' });

    // Reload once the new SW has claimed this client.
    const handleControllerChange = () => {
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange, {
      once: true,
    });
  }, [registration]);

  // ── getVersion ─────────────────────────────────────────────────────────────

  const getVersion = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const controller = navigator.serviceWorker?.controller;
      if (controller == null) {
        reject(new Error('No active service worker'));
        return;
      }

      const channel = new MessageChannel();

      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('SW version request timed out'));
      }, 3_000);

      channel.port1.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        channel.port1.close();
        const msg = event.data as { type: string; version: string };
        if (msg.type === 'SW_VERSION') {
          resolve(msg.version);
        } else {
          reject(new Error('Unexpected SW response'));
        }
      };

      controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  }, []);

  return { isRegistered, updateAvailable, applyUpdate, getVersion, registration };
}
