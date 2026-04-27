'use client';

/**
 * Google Maps JS API loader — singleton using @googlemaps/js-api-loader.
 * Ensures the SDK is only loaded once regardless of how many components import it.
 */

import { Loader } from '@googlemaps/js-api-loader';

let loaderInstance: Loader | null = null;
let loadPromise: Promise<typeof google> | null = null;

export function getMapsLoader(): Loader {
  if (!loaderInstance) {
    const apiKey = process.env['NEXT_PUBLIC_GOOGLE_MAPS_KEY'];
    if (!apiKey) throw new Error('NEXT_PUBLIC_GOOGLE_MAPS_KEY is not configured');

    loaderInstance = new Loader({
      apiKey,
      version:   'weekly',
      libraries: ['places', 'geometry', 'routes'],
      region:    'IN',
      language:  'en',
    });
  }
  return loaderInstance;
}

/**
 * Load the Maps API and return the global `google` namespace.
 * Safe to call multiple times — returns the same promise on concurrent calls.
 */
export async function loadMapsApi(): Promise<typeof google> {
  // Only skip loading if the Map constructor is actually available.
  if (typeof window !== 'undefined' && window.google?.maps?.Map) {
    return window.google as typeof google;
  }
  if (loadPromise) return loadPromise;
  loadPromise = getMapsLoader().load();
  return loadPromise;
}
