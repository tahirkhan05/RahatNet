'use client';

/**
 * Geocoding helpers — convert between addresses/district names and lat/lng.
 * Uses the Maps Geocoding API loaded via the singleton loader.
 */

import { loadMapsApi } from './loader';

export interface GeocodingResult {
  readonly lat:           number;
  readonly lng:           number;
  readonly formattedAddress: string;
  readonly district:      string | null;
  readonly state:         string | null;
}

/**
 * Forward geocode: address string → coordinates.
 * Returns null when the address cannot be found.
 */
export async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  await loadMapsApi();

  return new Promise((resolve) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode(
      { address, region: 'IN' },
      (results, status) => {
        if (status !== 'OK' || !results || results.length === 0) {
          resolve(null);
          return;
        }

        const result     = results[0]!;
        const location   = result.geometry.location;
        const components = result.address_components;

        const getComponent = (type: string) =>
          components.find((c) => c.types.includes(type))?.long_name ?? null;

        resolve({
          lat:              location.lat(),
          lng:              location.lng(),
          formattedAddress: result.formatted_address,
          district:         getComponent('administrative_area_level_3') ?? getComponent('administrative_area_level_2'),
          state:            getComponent('administrative_area_level_1'),
        });
      },
    );
  });
}

/**
 * Reverse geocode: coordinates → address.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeocodingResult | null> {
  await loadMapsApi();

  return new Promise((resolve) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode(
      { location: { lat, lng } },
      (results, status) => {
        if (status !== 'OK' || !results || results.length === 0) {
          resolve(null);
          return;
        }

        const result     = results[0]!;
        const components = result.address_components;

        const getComponent = (type: string) =>
          components.find((c) => c.types.includes(type))?.long_name ?? null;

        resolve({
          lat,
          lng,
          formattedAddress: result.formatted_address,
          district:         getComponent('administrative_area_level_3') ?? getComponent('administrative_area_level_2'),
          state:            getComponent('administrative_area_level_1'),
        });
      },
    );
  });
}
