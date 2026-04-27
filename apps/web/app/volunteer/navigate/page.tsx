'use client';

import * as React from 'react';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Phone, CheckCircle2, AlertTriangle,
  Users, Clock, MapPin, Navigation, Loader2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { CanonicalNeed } from '@rahatnet/types';
import { COLLECTIONS } from '@rahatnet/types';

function NavigateContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { user } = useAuth();

  const needId = params.get('needId');
  const assignmentId = params.get('assignmentId');

  const [need, setNeed] = React.useState<CanonicalNeed | null>(null);
  const [citizenPhone, setCitizenPhone] = React.useState<string | null>(null);
  const [citizenName, setCitizenName] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [mapLoaded, setMapLoaded] = React.useState(false);
  const mapRef = React.useRef<HTMLDivElement>(null);
  const mapInstance = React.useRef<google.maps.Map | null>(null);
  const COORDINATOR_PHONE = process.env['NEXT_PUBLIC_COORDINATOR_PHONE'] ?? '';

  // Load need data
  React.useEffect(() => {
    if (!needId) return;
    void (async () => {
      const { getDocument } = await import('@/lib/firebase/firestore');
      const n = await getDocument<CanonicalNeed>(COLLECTIONS.NEEDS, needId);
      if (n) {
        setNeed(n);
        // Reverse-geocode the need location for a human-readable address
        if (n.location?.lat && n.location?.lng) {
          try {
            const { reverseGeocode } = await import('@/lib/maps/geocoding');
            const geo = await reverseGeocode(n.location.lat, n.location.lng);
            if (geo?.formattedAddress) {
              setNeed((prev) => prev ? {
                ...prev,
                location: { ...prev.location, address: geo.formattedAddress } as typeof prev.location,
              } : prev);
            }
          } catch { /* silent */ }
        }
        // Fetch citizen contact
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((n as any).reporterIds?.[0]) {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          const { firebaseApp } = await import('@/lib/firebase/client');
          const db = getFirestore(firebaseApp);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const snap = await getDoc(doc(db, 'users', (n as any).reporterIds[0]));
          if (snap.exists()) {
            setCitizenPhone(snap.data()['phoneNumber'] ?? null);
            setCitizenName(snap.data()['displayName'] ?? 'Citizen');
          }
        }
      }
    })();
  }, [needId]);

  // Load Google Maps with routing
  React.useEffect(() => {
    if (!need || !mapRef.current) return;

    void (async () => {
      const { loadMapsApi } = await import('@/lib/maps/loader');
      await loadMapsApi();

      const destination = { lat: need.location.lat, lng: need.location.lng };

      const map = new google.maps.Map(mapRef.current!, {
        center: destination,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
          { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        ],
      });
      mapInstance.current = map;

      // Destination marker (red pin)
      new google.maps.Marker({
        position: destination,
        map,
        title: need.title,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: '#ef4444',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
      });

      // Try to get volunteer's current location and draw route
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };

          // Volunteer marker (blue)
          new google.maps.Marker({
            position: origin,
            map,
            title: 'Your location',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: '#3b82f6',
              fillOpacity: 1,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
          });

          // Draw route
          const directionsService = new google.maps.DirectionsService();
          const directionsRenderer = new google.maps.DirectionsRenderer({
            suppressMarkers: true,
            polylineOptions: { strokeColor: '#f27527', strokeWeight: 4 },
          });
          directionsRenderer.setMap(map);

          directionsService.route({
            origin,
            destination,
            travelMode: google.maps.TravelMode.DRIVING,
          }, (result, status) => {
            if (status === 'OK' && result) {
              directionsRenderer.setDirections(result);
              // Fit bounds to show full route
              const bounds = new google.maps.LatLngBounds();
              bounds.extend(origin);
              bounds.extend(destination);
              map.fitBounds(bounds);
            }
          });
        });
      }

      setMapLoaded(true);
    })();
  }, [need]);

  const handleComplete = async () => {
    if (!assignmentId) return;
    setCompleting(true);
    try {
      const res = await fetch(`/api/dispatch/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
      if (res.ok) {
        setDone(true);
        setTimeout(() => router.replace('/volunteer'), 2000);
      }
    } finally {
      setCompleting(false);
    }
  };

  if (done) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <CheckCircle2 className="h-10 w-10 text-green-600" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Task Complete!</h1>
        <p className="text-muted-foreground">Thank you for helping. Returning to dashboard…</p>
      </div>
    );
  }

  if (!need) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const SEVERITY_COLOR: Record<string, string> = {
    CRITICAL: 'bg-red-500',
    URGENT: 'bg-amber-500',
    NORMAL: 'bg-blue-500',
    LOW: 'bg-muted',
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Map — takes most of the screen */}
      <div className="relative flex-1">
        <div ref={mapRef} className="h-full w-full" />

        {/* Back button overlay */}
        <button
          onClick={() => router.back()}
          className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-2 text-sm font-medium text-foreground shadow-md backdrop-blur"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        {/* Loading overlay */}
        {!mapLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* Bottom sheet — Swiggy/Zomato style */}
      <div className="shrink-0 rounded-t-3xl border-t border-border bg-card shadow-2xl">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        <div className="space-y-4 px-4 pb-6 pt-2">
          {/* Need type + severity */}
          <div className="flex items-center justify-between">
            <div>
              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold text-white ${SEVERITY_COLOR[need.severity ?? 'NORMAL']}`}>
                {need.severity}
              </span>
              <h2 className="mt-1 text-lg font-bold text-foreground">{need.title}</h2>
            </div>
          </div>

          {/* Description */}
          {need.description && (
            <p className="text-sm text-muted-foreground">{need.description}</p>
          )}

          {/* Meta */}
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate max-w-[180px]">{(need.location as unknown as {address?: string}).address ?? 'See map'}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-primary" />
              {need.affectedCount} {need.affectedCount === 1 ? 'person' : 'people'}
            </span>
            {need.hasVulnerable && (
              <span className="flex items-center gap-1 text-amber-600">
                <AlertTriangle className="h-4 w-4" /> Includes vulnerable
              </span>
            )}
          </div>

          {/* Citizen contact */}
          {citizenName && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-background p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{citizenName}</p>
                <p className="text-xs text-muted-foreground">Person who needs help</p>
              </div>
              {citizenPhone ? (
                <a href={`tel:${citizenPhone}`}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
                  <Phone className="h-4 w-4" /> Call
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">No phone</span>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {/* Open in Google Maps for turn-by-turn */}
            <a
              href={`https://maps.google.com/maps?daddr=${(need.location as unknown as {lat:number}).lat},${(need.location as unknown as {lng:number}).lng}&travelmode=driving`}
              target="_blank" rel="noopener noreferrer"
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm font-semibold text-foreground"
            >
              <Navigation className="h-4 w-4 text-primary" /> Turn-by-turn
            </a>

            <button
              onClick={() => void handleComplete()}
              disabled={completing}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
            >
              {completing
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <CheckCircle2 className="h-4 w-4" />}
              Mark Complete
            </button>
          </div>

          {/* Emergency coordinator */}
          {COORDINATOR_PHONE && (
            <a href={`tel:${COORDINATOR_PHONE}`}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-accent">
              <Phone className="h-3.5 w-3.5" /> Emergency: Call Coordinator
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NavigatePage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    }>
      <NavigateContent />
    </Suspense>
  );
}
