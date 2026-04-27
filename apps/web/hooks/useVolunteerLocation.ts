'use client';

/**
 * useVolunteerLocation — manages the volunteer's live GPS and RTDB publishing.
 *
 * Responsibilities:
 *  1. Request geolocation permission gracefully.
 *  2. Watch the device position continuously (high accuracy, heading, speed).
 *  3. Publish to RTDB /volunteerLocations/{uid} every 30 seconds when Available.
 *  4. Stop publishing when:
 *       - The volunteer toggles to UNAVAILABLE.
 *       - The app is hidden / backgrounded (Page Visibility API).
 *       - Battery level drops below 15% (Battery Status API, graceful fallback).
 *  5. Remove the RTDB entry when publishing stops so the volunteer disappears
 *     from the war-room map immediately (don't wait for the 30-second timeout).
 *
 * Returns the current position plus a `batteryLow` flag so the UI can display
 * a warning before the feature silently stops.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VolunteerLocationState {
  /** WGS-84 latitude, or null when permission not granted / GPS unavailable. */
  readonly lat:        number | null;
  /** WGS-84 longitude. */
  readonly lng:        number | null;
  /** Horizontal accuracy radius in metres. */
  readonly accuracy:   number | null;
  /** Compass heading in degrees (0 = North). Null on many desktop browsers. */
  readonly heading:    number | null;
  /** Speed in m/s.  Null when stationary or unsupported. */
  readonly speed:      number | null;
  /** True while waiting for the first GPS fix. */
  readonly isLoading:  boolean;
  /** Non-null when the browser denied permission or GPS is unavailable. */
  readonly error:      string | null;
  /** True when battery is below 15% (location updates paused to save power). */
  readonly batteryLow: boolean;
  /** True when the app is backgrounded (location updates paused). */
  readonly paused:     boolean;
}

// ---------------------------------------------------------------------------
// Battery Status API — not in lib.dom.d.ts
// ---------------------------------------------------------------------------

interface BatteryManager extends EventTarget {
  readonly level:       number;   // 0–1
  readonly charging:    boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
  addEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
  removeEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?(): Promise<BatteryManager>;
}

const BATTERY_THRESHOLD = 0.15;  // 15%
const PUBLISH_INTERVAL_MS = 30_000;  // 30 seconds

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseVolunteerLocationOptions {
  /** The volunteer's Firebase Auth UID.  Required for RTDB publishing. */
  uid:          string | null;
  /** When false, position is still tracked locally but not published to RTDB. */
  isAvailable:  boolean;
}

export function useVolunteerLocation({
  uid,
  isAvailable,
}: UseVolunteerLocationOptions): VolunteerLocationState {
  const [state, setState] = useState<VolunteerLocationState>({
    lat: null, lng: null, accuracy: null,
    heading: null, speed: null,
    isLoading: true, error: null,
    batteryLow: false, paused: false,
  });

  // Keep the latest position in a ref so the publish interval can read it
  // without the interval needing to be rebuilt on every position update.
  const latestPositionRef = useRef<{
    lat: number; lng: number; heading: number; speed: number;
  } | null>(null);

  const batteryLowRef   = useRef(false);
  const pausedRef       = useRef(false);
  const publishTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Battery Status API ────────────────────────────────────────────────────

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (!nav.getBattery) return;

    let battery: BatteryManager | null = null;

    const updateBattery = () => {
      if (!battery) return;
      const low = !battery.charging && battery.level < BATTERY_THRESHOLD;
      batteryLowRef.current = low;
      setState((prev) => ({ ...prev, batteryLow: low }));
    };

    void nav.getBattery().then((b) => {
      battery = b;
      updateBattery();
      b.addEventListener('levelchange', updateBattery);
      b.addEventListener('chargingchange', updateBattery);
    });

    return () => {
      if (battery) {
        battery.removeEventListener('levelchange', updateBattery);
        battery.removeEventListener('chargingchange', updateBattery);
      }
    };
  }, []);

  // ── Page Visibility API ───────────────────────────────────────────────────

  useEffect(() => {
    const onVisibilityChange = () => {
      const paused = document.visibilityState === 'hidden';
      pausedRef.current = paused;
      setState((prev) => ({ ...prev, paused }));

      // When the app comes back to the foreground, publish immediately.
      if (!paused) void publishLocation();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── GPS watch ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!navigator.geolocation) {
      setState((prev) => ({
        ...prev,
        error: 'Location is not supported on this device.',
        isLoading: false,
      }));
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading, speed } = pos.coords;
        latestPositionRef.current = {
          lat:     latitude,
          lng:     longitude,
          heading: heading ?? 0,
          speed:   speed   ?? 0,
        };
        setState((prev) => ({
          ...prev,
          lat:      latitude,
          lng:      longitude,
          accuracy,
          heading:  heading ?? prev.heading,
          speed:    speed   ?? prev.speed,
          isLoading: false,
          error:    null,
        }));
      },
      (err) => {
        setState((prev) => ({
          ...prev,
          error: err.code === 1
            ? 'Location permission denied. Please enable it in your browser settings.'
            : 'Could not determine your location.',
          isLoading: false,
        }));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // ── RTDB publish ──────────────────────────────────────────────────────────

  const publishLocation = useCallback(async () => {
    if (!uid) return;
    if (!isAvailable)           return;
    if (batteryLowRef.current)  return;
    if (pausedRef.current)      return;
    if (!latestPositionRef.current) return;

    const { lat, lng, heading, speed } = latestPositionRef.current;

    try {
      const { updateVolunteerLocation } = await import('@/lib/firebase/realtime');
      await updateVolunteerLocation(uid, lat, lng, heading, speed);
    } catch {
      // Non-fatal — RTDB client reconnects automatically.
    }
  }, [uid, isAvailable]);

  const removeLocation = useCallback(async () => {
    if (!uid) return;
    try {
      const { removeVolunteerLocation } = await import('@/lib/firebase/realtime');
      await removeVolunteerLocation(uid);
    } catch {
      // Non-fatal
    }
  }, [uid]);

  // ── Publish interval ──────────────────────────────────────────────────────

  useEffect(() => {
    if (isAvailable && uid) {
      // Publish immediately on becoming available.
      void publishLocation();

      publishTimerRef.current = setInterval(() => {
        void publishLocation();
      }, PUBLISH_INTERVAL_MS);
    } else {
      // Stop publishing and remove from the war-room map.
      if (publishTimerRef.current !== null) {
        clearInterval(publishTimerRef.current);
        publishTimerRef.current = null;
      }
      void removeLocation();
    }

    return () => {
      if (publishTimerRef.current !== null) {
        clearInterval(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, [isAvailable, uid, publishLocation, removeLocation]);

  // Remove from RTDB on unmount.
  useEffect(() => {
    return () => {
      if (publishTimerRef.current !== null) clearInterval(publishTimerRef.current);
      void removeLocation();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
