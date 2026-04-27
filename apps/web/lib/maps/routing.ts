'use client';

/**
 * Routing helpers — directions, ETA, distance matrix.
 */

import { loadMapsApi } from './loader';

export interface RouteResult {
  readonly distanceMetres:  number;
  readonly durationSeconds: number;
  readonly durationText:    string;
  readonly distanceText:    string;
  readonly encodedPolyline: string;
  readonly steps:           RouteStep[];
}

export interface RouteStep {
  readonly instruction: string;
  readonly distanceText: string;
}

/**
 * Calculate a driving route from origin to destination.
 */
export async function getDrivingRoute(
  originLat:  number, originLng:  number,
  destLat:    number, destLng:    number,
): Promise<RouteResult | null> {
  await loadMapsApi();

  return new Promise((resolve) => {
    const service = new google.maps.DirectionsService();
    service.route(
      {
        origin:      { lat: originLat, lng: originLng },
        destination: { lat: destLat,   lng: destLng   },
        travelMode:  google.maps.TravelMode.DRIVING,
        unitSystem:  google.maps.UnitSystem.METRIC,
      },
      (result, status) => {
        if (status !== 'OK' || !result) {
          resolve(null);
          return;
        }

        const leg = result.routes[0]?.legs[0];
        if (!leg) { resolve(null); return; }

        resolve({
          distanceMetres:  leg.distance?.value ?? 0,
          durationSeconds: leg.duration?.value ?? 0,
          durationText:    leg.duration?.text  ?? '',
          distanceText:    leg.distance?.text  ?? '',
          encodedPolyline: result.routes[0]?.overview_polyline ?? '',
          steps: leg.steps.map((s) => ({
            instruction:  s.instructions.replace(/<[^>]+>/g, ''),
            distanceText: s.distance?.text ?? '',
          })),
        });
      },
    );
  });
}

/**
 * Open Google Maps navigation in a new tab (mobile deep-link compatible).
 */
export function openGoogleMapsNavigation(destLat: number, destLng: number): void {
  const url = `https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}&travelmode=driving`;
  window.open(url, '_blank', 'noopener');
}
