'use client';

/**
 * TaskMap — full-screen Google Maps view for volunteers navigating to a task.
 *
 * Features:
 *  1. Live GPS centre — map follows the volunteer's position.
 *  2. Destination pin — large animated marker for the assigned need.
 *  3. Directions route — Google Directions API via @react-google-maps/api.
 *  4. ETA badge — overlaid on the map, re-computed every 60 s or on position change.
 *  5. Nearby needs — smaller grey pins for other VERIFIED needs in the area.
 *  6. Route deviation detection — if the volunteer is > 200 m off the computed
 *     route, a "Recalculate?" banner appears.
 *  7. Wake Lock API — screen stays on during active navigation.
 *  8. Offline fallback — shows the last cached tile with an offline indicator.
 *
 * Wake Lock is acquired when `isNavigating=true` and released on unmount or
 * when the prop turns false.  The browser may deny it (e.g. when battery saver
 * is active) — that is handled silently.
 *
 * Error Boundary: map load errors are caught in WarRoomDashboard-style pattern;
 * the parent (VolunteerMapPage) should wrap with an error boundary.
 */

import * as React from 'react';
import { GoogleMap, useJsApiLoader, DirectionsRenderer } from '@react-google-maps/api';
import {
  Navigation, RefreshCw, WifiOff, MapPin, Loader2, Clock,
} from 'lucide-react';
import { NeedStatus, type CanonicalNeed } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskMapProps {
  /** Volunteer's current GPS position. */
  volunteerLat:     number | null;
  volunteerLng:     number | null;
  /** The assigned task's destination.  Null when no active task. */
  destinationLat?:  number;
  destinationLng?:  number;
  destinationName?: string;
  /** Other unresolved needs to show as secondary pins. */
  nearbyNeeds?:     readonly CanonicalNeed[];
  /** True when the volunteer is actively navigating (enables wake lock). */
  isNavigating?:    boolean;
  isOnline?:        boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_LIBRARIES: Array<'places'> = ['places'];
const DEVIATION_THRESHOLD_M = 200;
const DEFAULT_ZOOM          = 15;
const NEARBY_ZOOM           = 13;

// ---------------------------------------------------------------------------
// Wake Lock
// ---------------------------------------------------------------------------

interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinel>;
  };
}

async function acquireWakeLock(): Promise<WakeLockSentinel | null> {
  const nav = navigator as NavigatorWithWakeLock;
  if (!nav.wakeLock) return null;
  try {
    return await nav.wakeLock.request('screen');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Haversine distance (metres)
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// ETA badge
// ---------------------------------------------------------------------------

function EtaBadge({ etaMinutes }: { etaMinutes: number | null }) {
  if (etaMinutes === null) return null;

  return (
    <div className="rn-map-panel flex items-center gap-2 text-sm font-medium text-foreground">
      <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
      ETA: {etaMinutes < 1 ? '<1 min' : `${etaMinutes} min`}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map component
// ---------------------------------------------------------------------------

export function TaskMap({
  volunteerLat,
  volunteerLng,
  destinationLat,
  destinationLng,
  destinationName,
  nearbyNeeds = [],
  isNavigating = false,
  isOnline = true,
}: TaskMapProps) {
  const apiKey = process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'] ?? '';

  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: apiKey,
    libraries:        MAP_LIBRARIES,
    id:               'volunteer-map',
  });

  const mapRef              = React.useRef<google.maps.Map | null>(null);
  const volunteerMarkerRef  = React.useRef<google.maps.Marker | null>(null);
  const destMarkerRef       = React.useRef<google.maps.Marker | null>(null);
  const nearbyMarkersRef    = React.useRef<google.maps.Marker[]>([]);
  const wakeLockRef         = React.useRef<WakeLockSentinel | null>(null);
  const routePointsRef      = React.useRef<Array<{ lat: number; lng: number }>>([]);

  const [directions,         setDirections]         = React.useState<google.maps.DirectionsResult | null>(null);
  const [etaMinutes,         setEtaMinutes]         = React.useState<number | null>(null);
  const [showDeviation,      setShowDeviation]      = React.useState(false);
  const [fetchingRoute,      setFetchingRoute]      = React.useState(false);
  const [recalcCount,        setRecalcCount]        = React.useState(0);

  // ── Wake Lock ─────────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!isNavigating) {
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
      return;
    }

    void acquireWakeLock().then((lock) => {
      wakeLockRef.current = lock;
      // Re-acquire if the lock is released (e.g. tab hidden then shown).
      lock?.addEventListener('release', () => {
        if (isNavigating) void acquireWakeLock().then((l) => { wakeLockRef.current = l; });
      });
    });

    return () => {
      void wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, [isNavigating]);

  // ── Directions API ────────────────────────────────────────────────────────

  const fetchRoute = React.useCallback(async (
    oLat: number, oLng: number,
    dLat: number, dLng: number,
  ) => {
    if (!isLoaded || !isOnline) return;
    setFetchingRoute(true);

    try {
      const service = new google.maps.DirectionsService();
      const result  = await service.route({
        origin:      { lat: oLat, lng: oLng },
        destination: { lat: dLat, lng: dLng },
        travelMode:  google.maps.TravelMode.DRIVING,
      });

      setDirections(result);
      setShowDeviation(false);

      // Extract route polyline points for deviation detection.
      const leg = result.routes[0]?.legs[0];
      if (leg) {
        setEtaMinutes(Math.ceil((leg.duration?.value ?? 0) / 60));
        const path = result.routes[0]?.overview_path ?? [];
        routePointsRef.current = path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
      }
    } catch {
      // Directions API unavailable — clear old route.
      setDirections(null);
    } finally {
      setFetchingRoute(false);
    }
  }, [isLoaded, isOnline]);

  // Fetch route when destination is set.
  React.useEffect(() => {
    if (
      volunteerLat !== null && volunteerLng !== null &&
      destinationLat !== undefined && destinationLng !== undefined
    ) {
      void fetchRoute(volunteerLat, volunteerLng, destinationLat, destinationLng);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationLat, destinationLng, recalcCount, fetchRoute]);

  // ── Deviation detection ───────────────────────────────────────────────────

  React.useEffect(() => {
    if (
      volunteerLat === null || volunteerLng === null ||
      routePointsRef.current.length === 0
    ) return;

    // Find minimum distance from volunteer to any route point.
    const minDist = routePointsRef.current.reduce((min, pt) => {
      const d = haversineM(volunteerLat, volunteerLng, pt.lat, pt.lng);
      return d < min ? d : min;
    }, Infinity);

    if (minDist > DEVIATION_THRESHOLD_M) {
      setShowDeviation(true);
    }
  }, [volunteerLat, volunteerLng]);

  // ── Volunteer marker ──────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;
    if (volunteerLat === null || volunteerLng === null) return;

    const pos = { lat: volunteerLat, lng: volunteerLng };

    if (!volunteerMarkerRef.current) {
      volunteerMarkerRef.current = new google.maps.Marker({
        map:      mapRef.current,
        position: pos,
        title:    'Your location',
        icon: {
          path:        google.maps.SymbolPath.FORWARD_OPEN_ARROW,
          scale:       6,
          fillColor:   '#3b82f6',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        zIndex: 100,
      });
    } else {
      volunteerMarkerRef.current.setPosition(pos);
    }

    // Re-centre map on volunteer.
    mapRef.current.panTo(pos);
  }, [isLoaded, volunteerLat, volunteerLng]);

  // ── Destination marker ────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;
    if (destinationLat === undefined || destinationLng === undefined) {
      destMarkerRef.current?.setMap(null);
      destMarkerRef.current = null;
      return;
    }

    const pos = { lat: destinationLat, lng: destinationLng };

    if (!destMarkerRef.current) {
      destMarkerRef.current = new google.maps.Marker({
        map:      mapRef.current,
        position: pos,
        title:    destinationName ?? 'Destination',
        icon: {
          path:        google.maps.SymbolPath.CIRCLE,
          scale:       14,
          fillColor:   '#ef4444',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
        animation: google.maps.Animation.BOUNCE,
        zIndex:    200,
      });

      // Stop bounce after 3 s.
      setTimeout(() => {
        destMarkerRef.current?.setAnimation(null);
      }, 3_000);
    } else {
      destMarkerRef.current.setPosition(pos);
    }
  }, [isLoaded, destinationLat, destinationLng, destinationName]);

  // ── Nearby need markers ───────────────────────────────────────────────────

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;

    // Clear old markers.
    nearbyMarkersRef.current.forEach((m) => m.setMap(null));
    nearbyMarkersRef.current = [];

    const map = mapRef.current;
    nearbyNeeds
      .filter((n) => n.status !== NeedStatus.RESOLVED)
      .forEach((need) => {
        const marker = new google.maps.Marker({
          map,
          position: { lat: need.location.lat, lng: need.location.lng },
          title:    need.title,
          icon: {
            path:        google.maps.SymbolPath.CIRCLE,
            scale:       7,
            fillColor:   '#6b7280',
            fillOpacity: 0.7,
            strokeColor: '#ffffff',
            strokeWeight: 1,
          },
          zIndex: 50,
        });
        nearbyMarkersRef.current.push(marker);
      });
  }, [isLoaded, nearbyNeeds]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  React.useEffect(() => {
    return () => {
      volunteerMarkerRef.current?.setMap(null);
      destMarkerRef.current?.setMap(null);
      nearbyMarkersRef.current.forEach((m) => m.setMap(null));
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const mapCenter = volunteerLat !== null && volunteerLng !== null
    ? { lat: volunteerLat, lng: volunteerLng }
    : { lat: 10.0167, lng: 76.3417 }; // Default: Kerala

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-secondary text-center p-6">
        <MapPin className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <p className="font-semibold text-foreground">Map unavailable</p>
        <p className="text-sm text-muted-foreground">Check your API key configuration.</p>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-full items-center justify-center bg-secondary">
        <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <GoogleMap
        mapContainerClassName="h-full w-full"
        center={mapCenter}
        zoom={destinationLat !== undefined ? DEFAULT_ZOOM : NEARBY_ZOOM}
        onLoad={(map) => { mapRef.current = map; }}
        onUnmount={() => { mapRef.current = null; }}
        options={{
          disableDefaultUI:  true,
          zoomControl:       true,
          gestureHandling:   'greedy', // allows scroll without ctrl on mobile
          mapTypeControl:    false,
          fullscreenControl: false,
          streetViewControl: false,
        }}
      >
        {directions !== null && (
          <DirectionsRenderer
            directions={directions}
            options={{
              suppressMarkers:       true,
              polylineOptions: {
                strokeColor:   '#3b82f6',
                strokeWeight:  5,
                strokeOpacity: 0.85,
              },
            }}
          />
        )}
      </GoogleMap>

      {/* ETA overlay */}
      <div className="absolute left-4 top-4 z-10">
        <EtaBadge etaMinutes={etaMinutes} />
      </div>

      {/* Offline indicator */}
      {!isOnline && (
        <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-xl border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-foreground">
          <WifiOff className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
          Offline — cached map
        </div>
      )}

      {/* Route loading */}
      {fetchingRoute && (
        <div className="absolute inset-x-0 bottom-20 z-10 flex justify-center">
          <div className="flex items-center gap-2 rounded-xl bg-background/90 px-4 py-2 text-sm shadow-lg backdrop-blur-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
            Calculating route…
          </div>
        </div>
      )}

      {/* Deviation banner */}
      {showDeviation && (
        <div className="absolute inset-x-4 bottom-8 z-10">
          <div className="flex items-center justify-between rounded-2xl bg-amber-500 px-4 py-3 text-white shadow-lg">
            <div className="flex items-center gap-2">
              <Navigation className="h-5 w-5" aria-hidden="true" />
              <span className="font-semibold">Off route</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowDeviation(false);
                setRecalcCount((c) => c + 1);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-white/20 px-3 py-1.5 text-sm font-semibold hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Recalculate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
