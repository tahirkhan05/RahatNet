'use client';

/**
 * WarRoomMap — Google Maps integration for the war-room dashboard.
 *
 * Layers (all toggleable):
 *  - Needs pins: colored by severity (red=critical, amber=urgent, blue=normal, green=resolved)
 *  - Volunteer markers: user avatars with real-time location
 *  - Heatmap: density overlay of unresolved needs
 *  - Disaster zone: polygon bounding box of the affected area
 *
 * Uses @react-google-maps/api (already in package.json).
 * The component is wrapped in an Error Boundary in WarRoomDashboard so map
 * API load failures show a graceful fallback instead of crashing the page.
 *
 * Marker clustering: via the @googlemaps/markerclusterer library loaded lazily.
 */

import * as React from 'react';
import { Layers, MapPin, Users, Satellite, ZoomIn, Flame } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  NeedSeverity,
  NeedStatus,
  type CanonicalNeed,
  type RawReport,
  type RealtimeVolunteerLocation,
  type BoundingBox,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Short text labels for map pins (SVG text — lucide icons can't be used inside google.maps SVG)
const NEED_TYPE_LABEL: Record<string, string> = {
  RESCUE: 'R',
  FOOD: 'F',
  MEDICINE: 'M',
  SHELTER: 'S',
  MENTAL_HEALTH: 'MH',
  INFRASTRUCTURE: 'I',
};

const SEVERITY_COLORS: Record<NeedSeverity, string> = {
  [NeedSeverity.CRITICAL]: '#ef4444',
  [NeedSeverity.URGENT]: '#f59e0b',
  [NeedSeverity.NORMAL]: '#3b82f6',
  [NeedSeverity.LOW]: '#6b7280',
};
const RESOLVED_COLOR = '#22c55e';

// Default center: Kerala (flood-prone)
const DEFAULT_CENTER = { lat: 10.0167, lng: 76.3417 };
const DEFAULT_ZOOM = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LayerState {
  needs: boolean;
  volunteers: boolean;
  density: boolean;
  zone: boolean;
}

interface WarRoomMapProps {
  needs: readonly CanonicalNeed[];
  /** Unprocessed survey raw reports — rendered as pending grey pins immediately. */
  surveyReports: readonly RawReport[];
  volunteerLocations: Readonly<Record<string, RealtimeVolunteerLocation>>;
  /** UID → display name for volunteer markers. Populated asynchronously. */
  volunteerNames: Readonly<Record<string, string>>;
  boundingBox: BoundingBox | null;
  selectedNeed: CanonicalNeed | null;
  onNeedClick: (need: CanonicalNeed) => void;
}

// ---------------------------------------------------------------------------
// Layer toggle button
// ---------------------------------------------------------------------------

function LayerToggle({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${active ? 'Hide' : 'Show'} ${label} layer`}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-background/90 text-foreground border-border hover:bg-accent border',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Map component
// ---------------------------------------------------------------------------

export function WarRoomMap({
  needs,
  surveyReports,
  volunteerLocations,
  volunteerNames,
  boundingBox,
  selectedNeed,
  onNeedClick,
}: WarRoomMapProps) {
  const [isLoaded, setIsLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<Error | undefined>(undefined);

  React.useEffect(() => {
    import('@/lib/maps/loader')
      .then(({ loadMapsApi }) =>
        loadMapsApi()
          .then(() => setIsLoaded(true))
          .catch((e: Error) => setLoadError(e)),
      )
      .catch((e: Error) => setLoadError(e));
  }, []);

  const mapRef = React.useRef<google.maps.Map | null>(null);
  const markersRef = React.useRef<Map<string, google.maps.Marker>>(new Map());
  const zoneRef = React.useRef<google.maps.Polygon | null>(null);
  const clusterRef = React.useRef<{
    addMarkers: (m: google.maps.Marker[]) => void;
    clearMarkers: () => void;
    setMap: (m: google.maps.Map | null) => void;
  } | null>(null);
  const densityCirclesRef = React.useRef<google.maps.Circle[]>([]);
  const infoWindowRef = React.useRef<google.maps.InfoWindow | null>(null);

  const [layers, setLayers] = React.useState<LayerState>({
    needs: true,
    volunteers: true,
    density: true,
    zone: true,
  });
  const [isSatellite, setIsSatellite] = React.useState(false);

  const toggleLayer = (key: keyof LayerState) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // ── Map init ──────────────────────────────────────────────────────────────
  const mapDivRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isLoaded || mapRef.current) return;
    if (typeof google === 'undefined' || !google.maps?.Map) return;
    if (!mapDivRef.current) return;

    const map = new google.maps.Map(mapDivRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'cooperative',
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      ],
    });
    mapRef.current = map;

    if (boundingBox !== null) {
      map.fitBounds({
        north: boundingBox.north,
        south: boundingBox.south,
        east: boundingBox.east,
        west: boundingBox.west,
      });
    }
  }, [isLoaded, boundingBox]);

  React.useEffect(() => {
    if (mapRef.current) mapRef.current.setMapTypeId(isSatellite ? 'satellite' : 'roadmap');
  }, [isSatellite]);

  const onLoad = React.useCallback((map: google.maps.Map) => {
    mapRef.current = map;
  }, []);
  const onUnmount = React.useCallback(() => {
    mapRef.current = null;
  }, []);

  // ── Need markers + clustering + density circles ───────────────────────────

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;
    const map = mapRef.current;

    // Clear old density circles
    densityCirclesRef.current.forEach((c) => c.setMap(null));
    densityCirclesRef.current = [];

    // Clear old cluster
    clusterRef.current?.setMap(null);

    // Remove all old markers
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current.clear();

    if (!layers.needs) return;

    const newMarkers: google.maps.Marker[] = [];

    for (const need of needs) {
      const isResolved = need.status === NeedStatus.RESOLVED;
      const isSurvey = (need as CanonicalNeed & { source?: string }).source === 'SURVEY';
      const color = isSurvey
        ? '#9ca3af'
        : isResolved
          ? RESOLVED_COLOR
          : (SEVERITY_COLORS[need.severity] ?? '#6b7280');
      const label = isSurvey ? 'SV' : (NEED_TYPE_LABEL[need.type as string] ?? '?');
      const scale = need.severity === NeedSeverity.CRITICAL ? 12 : 9;

      // Create SVG pin with text label
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
          <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 26 18 26S36 31.5 36 18C36 8.06 27.94 0 18 0z"
            fill="${color}" stroke="white" stroke-width="2"/>
          <text x="18" y="24" text-anchor="middle" font-size="11" font-weight="bold" fill="white" font-family="sans-serif">${label}</text>
        </svg>`;

      const marker = new google.maps.Marker({
        map: layers.needs ? map : null,
        position: { lat: need.location.lat, lng: need.location.lng },
        title: `${label} ${need.title}`,
        icon: {
          url: 'data:image/svg+xml,' + encodeURIComponent(svg),
          scaledSize: new google.maps.Size(36, 44),
          anchor: new google.maps.Point(18, 44),
        },
        zIndex: need.severity === NeedSeverity.CRITICAL ? 10 : 5,
      });

      // InfoWindow with need details
      const infoContent = `
        <div style="font-family:sans-serif;max-width:220px;padding:4px">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">${need.title}</div>
          ${isSurvey ? '<div style="font-size:10px;background:#f3f4f6;color:#6b7280;padding:1px 6px;border-radius:10px;display:inline-block;margin-bottom:4px">Community survey</div>' : ''}
          <div style="font-size:11px;color:#666;margin-bottom:6px">${need.description?.slice(0, 80) ?? ''}${(need.description?.length ?? 0) > 80 ? '…' : ''}</div>
          <div style="display:flex;gap:8px;font-size:11px">
            <span style="background:${color};color:white;padding:1px 6px;border-radius:10px">${isSurvey ? 'Survey' : need.severity}</span>
            <span>${need.affectedCount} people</span>
            ${need.hasVulnerable ? '<span style="color:#b45309">Vulnerable</span>' : ''}
          </div>
          <div style="margin-top:4px;font-size:11px;color:#888">${need.status}</div>
        </div>`;

      marker.addListener('click', () => {
        if (!infoWindowRef.current) {
          infoWindowRef.current = new google.maps.InfoWindow();
        }
        infoWindowRef.current.setContent(infoContent);
        infoWindowRef.current.open(map, marker);
        onNeedClick(need);
      });

      markersRef.current.set(need.id, marker);
      newMarkers.push(marker);

      // Density circles for active crisis needs only (not survey pre-mapped pins)
      if (
        !isResolved &&
        !isSurvey &&
        (need.severity === NeedSeverity.CRITICAL || need.severity === NeedSeverity.URGENT)
      ) {
        const circle = new google.maps.Circle({
          map,
          center: { lat: need.location.lat, lng: need.location.lng },
          radius: need.severity === NeedSeverity.CRITICAL ? 2000 : 1200,
          fillColor: color,
          fillOpacity: 0.08,
          strokeColor: color,
          strokeOpacity: 0.3,
          strokeWeight: 1,
          clickable: false,
        });
        densityCirclesRef.current.push(circle);
      }
    }

    // Cluster markers using @googlemaps/markerclusterer
    void (async () => {
      try {
        const { MarkerClusterer } = await import('@googlemaps/markerclusterer');
        const clusterer = new MarkerClusterer({
          map,
          markers: newMarkers,
          renderer: {
            render: ({ count, position }) =>
              new google.maps.Marker({
                position,
                icon: {
                  url:
                    'data:image/svg+xml,' +
                    encodeURIComponent(`
                  <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44">
                    <circle cx="22" cy="22" r="20" fill="#f27527" stroke="white" stroke-width="2" opacity="0.9"/>
                    <text x="22" y="27" text-anchor="middle" font-size="14" font-weight="bold" fill="white">${count}</text>
                  </svg>`),
                  scaledSize: new google.maps.Size(44, 44),
                  anchor: new google.maps.Point(22, 22),
                },
                title: `${count} needs in this area`,
                zIndex: 100,
              }),
          },
        });
        // Store a compatible interface
        clusterRef.current = {
          addMarkers: (m) => clusterer.addMarkers(m),
          clearMarkers: () => clusterer.clearMarkers(),
          setMap: (m) => clusterer.setMap(m),
        };
      } catch {
        /* clustering not critical */
      }
    })();
  }, [isLoaded, needs, layers.needs, onNeedClick]);

  // Highlight selected need marker
  React.useEffect(() => {
    if (!isLoaded) return;
    for (const [id, marker] of markersRef.current.entries()) {
      const isSelected = id === selectedNeed?.id;
      marker.setZIndex(
        isSelected
          ? 999
          : needs.find((n) => n.id === id)?.severity === NeedSeverity.CRITICAL
            ? 10
            : 5,
      );
      if (isSelected) {
        // Pulse effect — slightly enlarge
        const need = needs.find((n) => n.id === id);
        const color =
          need?.status === NeedStatus.RESOLVED
            ? RESOLVED_COLOR
            : (SEVERITY_COLORS[need?.severity ?? NeedSeverity.NORMAL] ?? '#6b7280');
        const selLabel = NEED_TYPE_LABEL[(need?.type as string) ?? ''] ?? '?';
        const svg = `
          <svg xmlns="http://www.w3.org/2000/svg" width="44" height="54" viewBox="0 0 44 54">
            <path d="M22 0C9.85 0 0 9.85 0 22c0 16.5 22 32 22 32S44 38.5 44 22C44 9.85 34.15 0 22 0z"
              fill="${color}" stroke="white" stroke-width="3"/>
            <text x="22" y="28" text-anchor="middle" font-size="13" font-weight="bold" fill="white" font-family="sans-serif">${selLabel}</text>
          </svg>`;
        marker.setIcon({
          url: 'data:image/svg+xml,' + encodeURIComponent(svg),
          scaledSize: new google.maps.Size(44, 54),
          anchor: new google.maps.Point(22, 54),
        });
      }
    }
  }, [isLoaded, selectedNeed, needs]);

  // ── Survey raw report pins (pending, not yet AI-processed) ───────────────

  const surveyMarkersRef = React.useRef<Map<string, google.maps.Marker>>(new Map());

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;
    const map = mapRef.current;

    // Remove pins for reports no longer in the list
    const currentIds = new Set(surveyReports.map((r) => r.id));
    for (const [id, marker] of surveyMarkersRef.current.entries()) {
      if (!currentIds.has(id)) {
        marker.setMap(null);
        surveyMarkersRef.current.delete(id);
      }
    }

    for (const report of surveyReports) {
      if (surveyMarkersRef.current.has(report.id)) continue;
      if (!report.location?.lat || !report.location?.lng) continue;

      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44">
          <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 26 18 26S36 31.5 36 18C36 8.06 27.94 0 18 0z"
            fill="#9ca3af" stroke="white" stroke-width="2"/>
          <text x="18" y="24" text-anchor="middle" font-size="11" font-weight="bold" fill="white" font-family="sans-serif">SV</text>
        </svg>`;

      const marker = new google.maps.Marker({
        map,
        position: { lat: report.location.lat, lng: report.location.lng },
        title: `Survey: ${report.locationName}`,
        icon: {
          url: 'data:image/svg+xml,' + encodeURIComponent(svg),
          scaledSize: new google.maps.Size(36, 44),
          anchor: new google.maps.Point(18, 44),
        },
        zIndex: 3,
      });

      marker.addListener('click', () => {
        if (!infoWindowRef.current) {
          infoWindowRef.current = new google.maps.InfoWindow();
        }
        infoWindowRef.current.setContent(`
          <div style="font-family:sans-serif;max-width:220px;padding:4px">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px">Community survey</div>
            <div style="font-size:11px;color:#666;margin-bottom:6px">${report.description?.slice(0, 100) ?? ''}${(report.description?.length ?? 0) > 100 ? '…' : ''}</div>
            <div style="display:flex;gap:8px;font-size:11px">
              <span style="background:#9ca3af;color:white;padding:1px 6px;border-radius:10px">Survey</span>
              <span>${report.affectedCount} people</span>
              ${report.hasVulnerable ? '<span style="color:#b45309">Vulnerable</span>' : ''}
            </div>
            <div style="margin-top:4px;font-size:10px;color:#aaa">Awaiting AI processing</div>
          </div>`);
        infoWindowRef.current.open(map, marker);
      });

      surveyMarkersRef.current.set(report.id, marker);
    }
  }, [isLoaded, surveyReports]);

  // ── Volunteer markers ─────────────────────────────────────────────────────

  const volunteerMarkersRef = React.useRef<Map<string, google.maps.Marker>>(new Map());

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null) return;

    const map = mapRef.current;
    const current = volunteerMarkersRef.current;
    const seenUids = new Set<string>();

    for (const [uid, loc] of Object.entries(volunteerLocations)) {
      if (!loc.isAvailable) continue;
      seenUids.add(uid);
      const displayName = volunteerNames[uid] ?? `Volunteer ${uid.slice(0, 6)}`;
      const statusColor = loc.isAvailable ? '#10b981' : '#9ca3af';

      if (current.has(uid)) {
        const m = current.get(uid) as google.maps.Marker;
        m.setPosition({ lat: loc.lat, lng: loc.lng });
        m.setTitle(displayName);
        m.setVisible(layers.volunteers);
        continue;
      }

      const marker = new google.maps.Marker({
        map,
        position: { lat: loc.lat, lng: loc.lng },
        title: displayName,
        visible: layers.volunteers,
        icon: {
          path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
          scale: 4,
          fillColor: statusColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 1,
          rotation: loc.heading,
        },
      });

      // InfoWindow with volunteer name and status
      marker.addListener('click', () => {
        if (!infoWindowRef.current) {
          infoWindowRef.current = new google.maps.InfoWindow();
        }
        const statusColor = loc.isAvailable ? '#16a34a' : '#9ca3af';
        const statusText = loc.isAvailable ? 'Available' : 'Busy';
        infoWindowRef.current.setContent(`
          <div style="font-family:sans-serif;padding:4px;min-width:140px">
            <div style="font-weight:600;font-size:13px;margin-bottom:3px">${displayName}</div>
            <div style="font-size:11px;color:${statusColor};font-weight:500">${statusText}</div>
            ${loc.speed != null && loc.speed > 0 ? `<div style="font-size:11px;color:#888;margin-top:2px">Speed: ${Math.round(loc.speed)} km/h</div>` : ''}
          </div>`);
        infoWindowRef.current.open(map, marker);
      });

      current.set(uid, marker);
    }

    // Remove departed volunteers.
    for (const [uid, marker] of current.entries()) {
      if (!seenUids.has(uid)) {
        marker.setMap(null);
        current.delete(uid);
      }
    }
  }, [isLoaded, volunteerLocations, volunteerNames, layers.volunteers]);

  // ── Disaster zone polygon ─────────────────────────────────────────────────

  React.useEffect(() => {
    if (!isLoaded || mapRef.current === null || boundingBox === null) return;

    const coords = [
      { lat: boundingBox.north, lng: boundingBox.west },
      { lat: boundingBox.north, lng: boundingBox.east },
      { lat: boundingBox.south, lng: boundingBox.east },
      { lat: boundingBox.south, lng: boundingBox.west },
    ];

    if (zoneRef.current === null) {
      zoneRef.current = new google.maps.Polygon({
        paths: coords,
        map: layers.zone ? mapRef.current : null,
        strokeColor: '#f59e0b',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.07,
      });
    } else {
      zoneRef.current.setPaths(coords);
      zoneRef.current.setMap(layers.zone ? mapRef.current : null);
      densityCirclesRef.current.forEach((c) =>
        c.setMap(layers.density && mapRef.current ? mapRef.current : null),
      );
    }
  }, [isLoaded, boundingBox, layers.zone, layers.density]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  React.useEffect(() => {
    return () => {
      for (const m of markersRef.current.values()) m.setMap(null);
      for (const m of volunteerMarkersRef.current.values()) m.setMap(null);
      for (const m of surveyMarkersRef.current.values()) m.setMap(null);
      densityCirclesRef.current.forEach((c) => c.setMap(null));
      clusterRef.current?.setMap(null);
      infoWindowRef.current?.close();
      zoneRef.current?.setMap(null);
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loadError !== undefined) {
    return (
      <div className="bg-secondary flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <MapPin className="text-muted-foreground h-10 w-10" aria-hidden="true" />
        <div>
          <p className="text-foreground font-semibold">Map unavailable</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Google Maps failed to load. Check your API key configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {/* Map div — always mounted so ref is available when isLoaded fires */}
      <div ref={mapDivRef} className="h-full w-full" />
      {!isLoaded && (
        <div className="bg-muted/50 absolute inset-0 flex items-center justify-center">
          <div className="text-muted-foreground text-sm">Loading map...</div>
        </div>
      )}

      {/* Controls overlay */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-wrap gap-2">
        <LayerToggle
          label="Needs"
          icon={<MapPin className="h-3.5 w-3.5" aria-hidden="true" />}
          active={layers.needs}
          onClick={() => toggleLayer('needs')}
        />
        <LayerToggle
          label="Volunteers"
          icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />}
          active={layers.volunteers}
          onClick={() => toggleLayer('volunteers')}
        />
        <LayerToggle
          label="Density"
          icon={<Flame className="h-3.5 w-3.5" aria-hidden="true" />}
          active={layers.density}
          onClick={() => toggleLayer('density')}
        />
        <LayerToggle
          label="Zone"
          icon={<Layers className="h-3.5 w-3.5" aria-hidden="true" />}
          active={layers.zone}
          onClick={() => toggleLayer('zone')}
        />
        <LayerToggle
          label={isSatellite ? 'Map' : 'Satellite'}
          icon={<Satellite className="h-3.5 w-3.5" aria-hidden="true" />}
          active={isSatellite}
          onClick={() => setIsSatellite((v) => !v)}
        />
        {/* Zoom to disaster */}
        {boundingBox !== null && (
          <button
            type="button"
            onClick={() => {
              mapRef.current?.fitBounds({
                north: boundingBox.north,
                south: boundingBox.south,
                east: boundingBox.east,
                west: boundingBox.west,
              });
            }}
            className="bg-background/90 border-border text-foreground hover:bg-accent focus-visible:ring-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2"
            aria-label="Zoom to disaster zone"
          >
            <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
            Fit zone
          </button>
        )}
      </div>

      {/* Need count badge */}
      <div className="border-border bg-background/90 text-foreground absolute right-4 top-4 z-10 rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur-sm">
        {needs.filter((n) => n.status !== NeedStatus.RESOLVED).length} active needs
      </div>
    </div>
  );
}
