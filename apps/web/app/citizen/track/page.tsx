'use client';

import { Suspense } from 'react';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Phone, Loader2, CheckCircle2, Clock } from 'lucide-react';

interface TrackData {
  volunteerName: string;
  volunteerPhoto: string | null;
  volunteerPhone: string | null;
  volunteerLat: number | null;
  volunteerLng: number | null;
  citizenLat: number;
  citizenLng: number;
  needTitle: string;
  needStatus: string;
}

function TrackContent() {
  const router = useRouter();
  const params = useSearchParams();
  const volunteerId = params.get('volunteerId');
  const needId = params.get('needId');

  const [data, setData] = React.useState<TrackData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [eta, setEta] = React.useState<string | null>(null);
  const mapRef = React.useRef<HTMLDivElement>(null);
  const mapInstance = React.useRef<google.maps.Map | null>(null);
  const volunteerMarker = React.useRef<google.maps.Marker | null>(null);
  const routeRenderer = React.useRef<google.maps.DirectionsRenderer | null>(null);

  // Load initial data
  React.useEffect(() => {
    if (!volunteerId || !needId) return;
    void (async () => {
      try {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const db = getFirestore(firebaseApp);

        const [volSnap, needSnap] = await Promise.all([
          getDoc(doc(db, 'users', volunteerId)),
          getDoc(doc(db, 'needs', needId)),
        ]);

        const vol = volSnap.data();
        const need = needSnap.data();

        const loc = need?.['location'] as Record<string, unknown> | null | undefined;
        // Firestore client SDK returns GeoPoints with .latitude/.longitude
        // Our bootstrap stores plain {lat, lng} objects
        // Handle all cases:
        let lat = 17.385, lng = 78.4867; // Hyderabad fallback
        if (loc) {
          const rawLat = (loc['lat'] ?? loc['latitude'] ?? loc['_lat']) as number | undefined;
          const rawLng = (loc['lng'] ?? loc['longitude'] ?? loc['_lng']) as number | undefined;
          // Only use if non-zero valid coordinates
          if (rawLat && rawLng && Math.abs(rawLat) > 0.1 && Math.abs(rawLng) > 0.1) {
            lat = rawLat;
            lng = rawLng;
          }
        }

        setData({
          volunteerName: vol?.['displayName'] ?? 'Volunteer',
          volunteerPhoto: vol?.['photoURL'] ?? null,
          volunteerPhone: vol?.['phoneNumber'] ?? null,
          volunteerLat: null,
          volunteerLng: null,
          citizenLat: lat,
          citizenLng: lng,
          needTitle: need?.['title'] ?? 'Help on the way',
          needStatus: need?.['status'] ?? 'ASSIGNED',
        });
        setLoading(false);
      } catch { setLoading(false); }
    })();
  }, [volunteerId, needId]);

  // Subscribe to volunteer live location from RTDB
  React.useEffect(() => {
    if (!volunteerId) return;
    let unsub: (() => void) | undefined;
    void (async () => {
      const { getDatabase, ref, onValue } = await import('firebase/database');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const rtdb = getDatabase(firebaseApp);
      const locRef = ref(rtdb, `volunteerLocations/${volunteerId}`);
      unsub = onValue(locRef, (snap) => {
        const loc = snap.val() as { lat?: number; lng?: number } | null;
        if (loc?.lat && loc?.lng) {
          setData(prev => prev ? { ...prev, volunteerLat: loc.lat!, volunteerLng: loc.lng! } : prev);
        }
      });
    })();
    return () => unsub?.();
  }, [volunteerId]);

  // Init map
  React.useEffect(() => {
    if (!data || !mapRef.current) return;
    void (async () => {
      const { loadMapsApi } = await import('@/lib/maps/loader');
      await loadMapsApi();
      if (mapInstance.current) return;

      const center = { lat: data.citizenLat, lng: data.citizenLng };
      const map = new google.maps.Map(mapRef.current!, {
        center,
        zoom: 14,
        disableDefaultUI: true,
        zoomControl: false,
        styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
      });
      mapInstance.current = map;

      // Citizen marker (destination — orange house pin)
      new google.maps.Marker({
        position: center,
        map,
        title: 'Your location',
        icon: {
          url: 'data:image/svg+xml,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="#f27527">
              <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
            </svg>
          `),
          scaledSize: new google.maps.Size(36, 36),
          anchor: new google.maps.Point(18, 36),
        },
      });

      routeRenderer.current = new google.maps.DirectionsRenderer({
        suppressMarkers: true,
        polylineOptions: { strokeColor: '#f27527', strokeWeight: 5, strokeOpacity: 0.8 },
      });
      routeRenderer.current.setMap(map);
    })();
  }, [data?.citizenLat, data?.citizenLng]);

  // Update volunteer marker and route when location changes
  React.useEffect(() => {
    if (!mapInstance.current || !data?.volunteerLat || !data?.volunteerLng) return;

    const volPos = { lat: data.volunteerLat, lng: data.volunteerLng };

    // Update or create volunteer marker (moving bike/person)
    if (!volunteerMarker.current) {
      volunteerMarker.current = new google.maps.Marker({
        position: volPos,
        map: mapInstance.current,
        title: data.volunteerName,
        icon: {
          url: 'data:image/svg+xml,' + encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
              <circle cx="22" cy="22" r="20" fill="#22c55e" stroke="white" stroke-width="3"/>
              <text x="22" y="28" text-anchor="middle" font-size="18" fill="white">🚶</text>
            </svg>
          `),
          scaledSize: new google.maps.Size(44, 44),
          anchor: new google.maps.Point(22, 22),
        },
      });
    } else {
      volunteerMarker.current.setPosition(volPos);
    }

    // Draw route from volunteer to citizen
    const directionsService = new google.maps.DirectionsService();
    directionsService.route({
      origin: volPos,
      destination: { lat: data.citizenLat, lng: data.citizenLng },
      travelMode: google.maps.TravelMode.DRIVING,
    }, (result, status) => {
      if (status === 'OK' && result && routeRenderer.current) {
        routeRenderer.current.setDirections(result);
        // Calculate ETA
        const leg = result.routes[0]?.legs[0];
        if (leg?.duration) setEta(leg.duration.text);
        // Fit bounds
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(volPos);
        bounds.extend({ lat: data.citizenLat, lng: data.citizenLng });
        mapInstance.current?.fitBounds(bounds, { top: 60, bottom: 200, left: 40, right: 40 });
      }
    });
  }, [data?.volunteerLat, data?.volunteerLng]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">No tracking data available.</p>
      </div>
    );
  }

  const isResolved = data.needStatus === 'RESOLVED' || data.needStatus === 'COMPLETED';

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Map */}
      <div className="relative flex-1">
        <div ref={mapRef} className="h-full w-full" />

        {/* Back */}
        <button onClick={() => router.back()}
          className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-2 text-sm font-medium shadow-md backdrop-blur">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        {/* ETA pill */}
        {eta && !isResolved && (
          <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-background/90 px-4 py-2 shadow-md backdrop-blur">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock className="h-4 w-4 text-primary" /> Arrives in {eta}
            </p>
          </div>
        )}

        {/* No location yet */}
        {!data.volunteerLat && !isResolved && (
          <div className="absolute inset-x-4 top-16 z-10 rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-2 text-center">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Waiting for volunteer's live location…
            </p>
          </div>
        )}
      </div>

      {/* Bottom sheet — Swiggy style */}
      <div className="shrink-0 rounded-t-3xl border-t border-border bg-card shadow-2xl">
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        <div className="px-4 pb-6 pt-2 space-y-4">
          {isResolved ? (
            <div className="flex items-center gap-3 rounded-xl bg-green-500/10 border border-green-500/30 p-4">
              <CheckCircle2 className="h-8 w-8 text-green-500 shrink-0" />
              <div>
                <p className="font-semibold text-green-600 dark:text-green-400">Help has arrived!</p>
                <p className="text-sm text-muted-foreground">Your need has been resolved.</p>
              </div>
            </div>
          ) : (
            <>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your volunteer</p>
                <p className="mt-1 font-bold text-lg text-foreground">{data.needTitle}</p>
              </div>

              <div className="flex items-center gap-4">
                {data.volunteerPhoto ? (
                  <img src={data.volunteerPhoto} alt="" className="h-14 w-14 rounded-full object-cover border-2 border-green-500" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10 border-2 border-green-500 text-xl font-bold text-green-600">
                    {data.volunteerName[0]}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground text-lg">{data.volunteerName}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                      {data.volunteerLat ? 'On the way to you' : 'Preparing to leave'}
                    </p>
                  </div>
                </div>
                {data.volunteerPhone && (
                  <a href={`tel:${data.volunteerPhone}`}
                    className="flex shrink-0 items-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm">
                    <Phone className="h-4 w-4" /> Call
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TrackPage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    }>
      <TrackContent />
    </Suspense>
  );
}
