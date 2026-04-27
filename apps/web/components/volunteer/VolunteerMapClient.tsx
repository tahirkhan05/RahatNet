'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Loader2, Phone, Users, AlertTriangle, Clock,
  CheckCircle2, ThumbsUp, Navigation, X,
} from 'lucide-react';
import { COLLECTIONS, type CanonicalNeed } from '@rahatnet/types';
import { useAuth } from '@/hooks/useAuth';

interface NeedWithAssignment extends CanonicalNeed {
  isAssigned?: boolean;
  assignmentId?: string;
}

export function VolunteerMapClient() {
  const router = useRouter();
  const { user } = useAuth();

  const [needs, setNeeds] = React.useState<NeedWithAssignment[]>([]);
  const [assignedNeedIds, setAssignedNeedIds] = React.useState<Set<string>>(new Set());
  const [assignmentMap, setAssignmentMap] = React.useState<Record<string, string>>({});
  const [selectedNeed, setSelectedNeed] = React.useState<NeedWithAssignment | null>(null);
  const [citizenInfo, setCitizenInfo] = React.useState<{ name: string; phone: string | null } | null>(null);
  const [mapLoaded, setMapLoaded] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [eta, setEta] = React.useState<string | null>(null);

  const mapRef = React.useRef<HTMLDivElement>(null);
  const mapInstance = React.useRef<google.maps.Map | null>(null);
  const markersRef = React.useRef<google.maps.Marker[]>([]);

  const DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'active-disaster-001';

  // Load assignments for this volunteer
  React.useEffect(() => {
    if (!user?.uid) return;
    let unsub: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, onSnapshot, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      const q = query(collection(db, 'assignments'), where('volunteerId', '==', user.uid), where('status', 'in', ['NOTIFIED', 'ACCEPTED', 'IN_PROGRESS', 'CREATED']));
      // Fallback without status filter if index isn't ready
      unsub = onSnapshot(query(collection(db, 'assignments'), where('volunteerId', '==', user.uid)), (snap) => {
        const ids = new Set<string>();
        const aMap: Record<string, string> = {};
        for (const d of snap.docs) {
          const s = d.data()['status'] as string;
          if (['NOTIFIED', 'ACCEPTED', 'IN_PROGRESS', 'CREATED'].includes(s)) {
            const needId = d.data()['needId'] as string;
            ids.add(needId);
            aMap[needId] = d.id;
          }
        }
        setAssignedNeedIds(ids);
        setAssignmentMap(aMap);
      });
    })();
    return () => unsub?.();
  }, [user?.uid]);

  // Load all verified needs
  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, onSnapshot, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      const q = query(collection(db, 'needs'), where('disasterEventId', '==', DISASTER_ID));
      unsub = onSnapshot(q, (snap) => {
        setNeeds(snap.docs.map(d => ({ id: d.id, ...d.data() } as NeedWithAssignment)));
      });
    })();
    return () => unsub?.();
  }, [DISASTER_ID]);

  // Load map and place markers
  React.useEffect(() => {
    if (!mapRef.current || needs.length === 0) return;

    void (async () => {
      const { loadMapsApi } = await import('@/lib/maps/loader');
      await loadMapsApi();

      if (!mapInstance.current) {
        const firstNeed = needs[0]!;
        mapInstance.current = new google.maps.Map(mapRef.current!, {
          center: { lat: firstNeed.location.lat, lng: firstNeed.location.lng },
          zoom: 13,
          disableDefaultUI: true,
          zoomControl: true,
          styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
        });

        // Volunteer location
        navigator.geolocation?.getCurrentPosition((pos) => {
          new google.maps.Marker({
            position: { lat: pos.coords.latitude, lng: pos.coords.longitude },
            map: mapInstance.current!,
            title: 'You',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10, fillColor: '#3b82f6', fillOpacity: 1,
              strokeColor: '#fff', strokeWeight: 2,
            },
          });
        });
      }

      // Clear old markers
      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];

      // Place markers for each need
      for (const need of needs) {
        const isAssigned = assignedNeedIds.has(need.id);
        const fillColor = isAssigned ? '#22c55e' : '#f27527';
        const marker = new google.maps.Marker({
          position: { lat: need.location.lat, lng: need.location.lng },
          map: mapInstance.current!,
          title: need.title,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: isAssigned ? 14 : 11,
            fillColor,
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
          },
        });

        marker.addListener('click', () => {
          setSelectedNeed({ ...need, isAssigned, assignmentId: assignmentMap[need.id] });
          setCitizenInfo(null);
          setEta(null);
          // Calculate ETA from volunteer's current position using routing.ts
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(async (pos) => {
              try {
                const { getDrivingRoute } = await import('@/lib/maps/routing');
                const route = await getDrivingRoute(
                  pos.coords.latitude, pos.coords.longitude,
                  need.location.lat, need.location.lng,
                );
                if (route) setEta(route.durationText);
              } catch { /* silent */ }
            });
          }
          // Fetch citizen info
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((need as any).reporterIds?.[0]) {
            void (async () => {
              const { doc, getDoc, getFirestore } = await import('firebase/firestore');
              const { firebaseApp } = await import('@/lib/firebase/client');
              const db = getFirestore(firebaseApp);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const snap = await getDoc(doc(db, 'users', (need as any).reporterIds![0]!));
              if (snap.exists()) {
                setCitizenInfo({ name: snap.data()['displayName'] ?? 'Citizen', phone: snap.data()['phoneNumber'] ?? null });
              }
            })();
          }
        });

        markersRef.current.push(marker);
      }

      setMapLoaded(true);
    })();
  }, [needs, assignedNeedIds, assignmentMap]);

  const handleInterest = async (needId: string) => {
    setSending(true);
    try {
      await fetch('/api/dispatch/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needId }),
      });
      setSelectedNeed(null);
    } finally {
      setSending(false);
    }
  };

  const SEVERITY_COLOR: Record<string, string> = {
    CRITICAL: 'bg-red-500', URGENT: 'bg-amber-500', NORMAL: 'bg-blue-500', LOW: 'bg-muted',
  };

  return (
    <div className="relative h-full w-full">
      {/* Map */}
      <div ref={mapRef} className="h-full w-full" />

      {/* Back button */}
      <button onClick={() => router.back()}
        className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-xl bg-background/90 px-3 py-2 text-sm font-medium shadow-md backdrop-blur">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {/* Legend */}
      <div className="absolute right-4 top-4 z-20 rounded-xl bg-background/90 px-3 py-2 text-xs shadow-md backdrop-blur space-y-1">
        <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-full bg-[#22c55e]" /> Your tasks</div>
        <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-full bg-[#f27527]" /> Available</div>
        <div className="flex items-center gap-1.5"><div className="h-3 w-3 rounded-full bg-[#3b82f6]" /> You</div>
      </div>

      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      )}

      {/* Selected need bottom panel */}
      {selectedNeed && (
        <div className="absolute inset-x-0 bottom-0 z-30 rounded-t-3xl border-t border-border bg-card shadow-2xl">
          <div className="flex justify-center pt-3 pb-1">
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
          <div className="space-y-3 px-4 pb-6 pt-2">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold text-white ${SEVERITY_COLOR[selectedNeed.severity ?? 'NORMAL']}`}>
                  {selectedNeed.severity}
                </span>
                {selectedNeed.isAssigned && (
                  <span className="ml-2 inline-block rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                    ✓ Assigned to you
                  </span>
                )}
                <h3 className="mt-1 font-bold text-foreground">{selectedNeed.title}</h3>
                {selectedNeed.description && (
                  <p className="text-sm text-muted-foreground">{selectedNeed.description}</p>
                )}
              </div>
              <button onClick={() => setSelectedNeed(null)}
                className="ml-2 shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {selectedNeed.affectedCount} people</span>
              {eta && <span className="flex items-center gap-1 text-primary font-medium"><Clock className="h-3.5 w-3.5" /> {eta} away</span>}
              {selectedNeed.hasVulnerable && (
                <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> Vulnerable</span>
              )}
            </div>

            {/* Citizen contact */}
            {citizenInfo && (
              <div className="flex items-center justify-between rounded-lg border border-border bg-background p-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">{citizenInfo.name}</p>
                  <p className="text-xs text-muted-foreground">Person who needs help</p>
                </div>
                {citizenInfo.phone && (
                  <a href={`tel:${citizenInfo.phone}`}
                    className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                    <Phone className="h-3.5 w-3.5" /> Call
                  </a>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2">
              {selectedNeed.isAssigned ? (
                <button
                  onClick={() => router.push(`/volunteer/navigate?needId=${selectedNeed.id}&assignmentId=${selectedNeed.assignmentId}`)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">
                  <Navigation className="h-4 w-4" /> Navigate
                </button>
              ) : (
                <button
                  onClick={() => void handleInterest(selectedNeed.id)}
                  disabled={sending}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm font-semibold text-primary disabled:opacity-60">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
                  I can help
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
