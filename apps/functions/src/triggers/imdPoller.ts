/**
 * IMD Alert Poller — Cloud Function (Scheduled, every 15 minutes)
 *
 * Polls three external alert sources for weather warnings affecting India:
 *
 *   1. IMD RSS / HTML (India Meteorological Department)
 *   2. Google Alerts RSS for key Indian disaster search terms
 *   3. NDMA API — when NDMA_API_URL env var is configured
 *
 * For new RED alerts  → activateDisasterMode() is called synchronously.
 * For new ORANGE alerts → coordinator confirmation banner is set; volunteers
 *                         are NOT yet notified automatically.
 *
 * Idempotency: Every alert is hashed by (alertType + district + date).
 * The Firestore /imdAlerts collection is queried before writing — safe to run
 * multiple times on the same data.
 *
 * Failure resilience:
 *   Each source is independently try/catched.
 *   After FAILURE_THRESHOLD consecutive empty runs, an admin FCM push fires.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import {
  DisasterType,
  IMDColorCode,
} from '@rahatnet/types';
import type { IMDAlert } from '@rahatnet/types';
import { activateDisasterMode } from './disasterActivation';

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

function log(
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
  operation: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const level = severity === 'INFO' ? 'info'
    : severity === 'WARNING'        ? 'warn'
    : 'error';
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ severity, operation, message, ...extra }));
}

// ---------------------------------------------------------------------------
// Deduplication hash (DJB2 — no crypto, deterministic)
// ---------------------------------------------------------------------------

function dedupHash(alertType: string, district: string, dateStr: string): string {
  const input = `${alertType.toUpperCase()}:${district.toLowerCase().trim()}:${dateStr}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// District geocoding: name → bounding box
// ---------------------------------------------------------------------------

const DISTRICT_BBOX: Readonly<Record<string, {
  north: number; south: number; east: number; west: number;
}>> = {
  // Kerala
  ernakulam:          { north: 10.33, south: 9.80,  east: 76.65, west: 76.10 },
  wayanad:            { north: 11.86, south: 11.39, east: 76.26, west: 75.72 },
  idukki:             { north: 10.35, south: 9.52,  east: 77.20, west: 76.55 },
  thrissur:           { north: 10.65, south: 10.10, east: 76.55, west: 76.00 },
  palakkad:           { north: 10.90, south: 10.27, east: 76.85, west: 76.25 },
  kozhikode:          { north: 11.73, south: 11.15, east: 76.23, west: 75.60 },
  malappuram:         { north: 11.30, south: 10.74, east: 76.38, west: 75.80 },
  kannur:             { north: 12.32, south: 11.75, east: 75.90, west: 75.30 },
  pathanamthitta:     { north: 9.53,  south: 8.93,  east: 77.11, west: 76.58 },
  kottayam:           { north: 9.97,  south: 9.36,  east: 76.95, west: 76.35 },
  alappuzha:          { north: 9.72,  south: 9.15,  east: 76.55, west: 76.10 },
  kollam:             { north: 9.05,  south: 8.55,  east: 76.90, west: 76.35 },
  thiruvananthapuram: { north: 8.73,  south: 8.17,  east: 77.35, west: 76.80 },
  kasaragod:          { north: 12.56, south: 12.04, east: 75.25, west: 74.65 },
  // Assam
  kamrup:             { north: 26.40, south: 25.85, east: 91.90, west: 91.25 },
  goalpara:           { north: 26.22, south: 25.75, east: 90.75, west: 90.14 },
  dhubri:             { north: 26.37, south: 25.85, east: 90.07, west: 89.65 },
  barpeta:            { north: 26.47, south: 26.02, east: 91.13, west: 90.54 },
  // Odisha
  puri:               { north: 20.15, south: 19.70, east: 86.17, west: 85.60 },
  ganjam:             { north: 19.75, south: 18.95, east: 85.20, west: 84.42 },
  cuttack:            { north: 20.65, south: 20.14, east: 86.01, west: 85.45 },
  // Default fallback
  india:              { north: 35.50, south: 6.75,  east: 97.40, west: 68.10 },
};

const DISTRICT_TO_STATE: Readonly<Record<string, string>> = {
  ernakulam: 'Kerala', wayanad: 'Kerala', idukki: 'Kerala', thrissur: 'Kerala',
  palakkad: 'Kerala', kozhikode: 'Kerala', malappuram: 'Kerala', kannur: 'Kerala',
  pathanamthitta: 'Kerala', kottayam: 'Kerala', alappuzha: 'Kerala',
  kollam: 'Kerala', thiruvananthapuram: 'Kerala', kasaragod: 'Kerala',
  kamrup: 'Assam', goalpara: 'Assam', dhubri: 'Assam', barpeta: 'Assam',
  puri: 'Odisha', ganjam: 'Odisha', cuttack: 'Odisha', khordha: 'Odisha',
};

export function getBoundingBox(
  districts: string[],
): { north: number; south: number; east: number; west: number } {
  const boxes = districts.map(
    (d) => DISTRICT_BBOX[d.toLowerCase().trim()] ?? DISTRICT_BBOX['india']!,
  );
  return {
    north: Math.max(...boxes.map((b) => b.north)),
    south: Math.min(...boxes.map((b) => b.south)),
    east:  Math.max(...boxes.map((b) => b.east)),
    west:  Math.min(...boxes.map((b) => b.west)),
  };
}

function inferState(districts: string[]): string {
  for (const d of districts) {
    const state = DISTRICT_TO_STATE[d.toLowerCase().trim()];
    if (state) return state;
  }
  return 'India';
}

// ---------------------------------------------------------------------------
// Disaster type inference
// ---------------------------------------------------------------------------

export function inferDisasterType(text: string): DisasterType {
  if (/cyclon|hurricane|typhoon|storm/i.test(text))    return DisasterType.CYCLONE;
  if (/earthquake|seismi|tremor/i.test(text))          return DisasterType.EARTHQUAKE;
  if (/landslide|mudslide|mudflow/i.test(text))        return DisasterType.LANDSLIDE;
  if (/drought|water\s*scarcity/i.test(text))          return DisasterType.DROUGHT;
  if (/wildfire|forest\s*fire/i.test(text))            return DisasterType.FIRE;
  return DisasterType.FLOOD; // Most common Indian disaster
}

// ---------------------------------------------------------------------------
// Shared alert type
// ---------------------------------------------------------------------------

interface ParsedAlert {
  readonly colorCode:  IMDColorCode;
  readonly alertType:  DisasterType;
  readonly districts:  string[];
  readonly state:      string;
  readonly headline:   string;
  readonly details:    string;
  readonly rawPayload: string;
  readonly source:     'IMD_RSS' | 'NDMA_API' | 'GOOGLE_ALERTS';
}

// ---------------------------------------------------------------------------
// Source 1: IMD RSS / HTML
// ---------------------------------------------------------------------------

async function fetchIMDRSS(): Promise<ParsedAlert[]> {
  const alerts: ParsedAlert[] = [];
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(
      'https://mausam.imd.gov.in/imd_latest/contents/warning_alerts.php',
      { signal: controller.signal },
    );
    clearTimeout(tid);
    if (!res.ok) {
      log('WARNING', 'fetchIMDRSS', `HTTP ${res.status}`);
      return alerts;
    }

    const text = await res.text();
    const raw  = text.slice(0, 8_000);

    const extractAlerts = (pattern: RegExp, code: IMDColorCode) => {
      for (const m of text.matchAll(pattern)) {
        const block   = m[0];
        const dMatch  = [...block.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:district|taluk|region)/gi)];
        const districts = dMatch.map((dm) => dm[1]?.trim() ?? '').filter(Boolean);
        if (districts.length === 0) districts.push('Unknown');
        const alertType = inferDisasterType(block);
        for (const d of districts) {
          alerts.push({
            colorCode:  code,
            alertType,
            districts:  [d],
            state:      inferState([d]),
            headline:   block.slice(0, 120).replace(/\s+/g, ' ').trim(),
            details:    block.slice(0, 500),
            rawPayload: raw.slice(0, 2_000),
            source:     'IMD_RSS',
          });
        }
      }
    };

    extractAlerts(/RED\s+ALERT[^<]{0,300}/gi,    IMDColorCode.RED);
    extractAlerts(/ORANGE\s+ALERT[^<]{0,300}/gi, IMDColorCode.ORANGE);

    log('INFO', 'fetchIMDRSS', `Extracted ${alerts.length} alerts`);
  } catch (err) {
    clearTimeout(tid);
    log('WARNING', 'fetchIMDRSS', 'Source failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Source 2: Google Alerts RSS
// ---------------------------------------------------------------------------

const GOOGLE_QUERIES = [
  'flood+warning+India',
  'cyclone+alert+India',
  'red+alert+rain+India',
] as const;

async function fetchGoogleAlertsRSS(): Promise<ParsedAlert[]> {
  const alerts: ParsedAlert[] = [];

  for (const query of GOOGLE_QUERIES) {
    const controller = new AbortController();
    const tid        = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(
        `https://www.google.com/alerts/feeds/00000000000000000000/${query}`,
        { signal: controller.signal },
      );
      clearTimeout(tid);
      if (!res.ok) continue;

      const xml = await res.text();

      for (const m of xml.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gi)) {
        const title = (m[1] ?? '').trim();
        if (!title) continue;
        const isRed    = /red\s+alert/i.test(title);
        const isOrange = /orange\s+alert/i.test(title);
        if (!isRed && !isOrange) continue;

        const dMatch    = [...title.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)*)\s+(?:district|floods?|rain)/gi)];
        const districts = dMatch.map((dm) => dm[1]?.trim() ?? '').filter(Boolean);
        if (districts.length === 0) continue;

        const alertType = inferDisasterType(title);
        for (const d of districts) {
          alerts.push({
            colorCode:  isRed ? IMDColorCode.RED : IMDColorCode.ORANGE,
            alertType,
            districts:  [d],
            state:      inferState([d]),
            headline:   title.slice(0, 200),
            details:    title,
            rawPayload: xml.slice(0, 2_000),
            source:     'GOOGLE_ALERTS',
          });
        }
      }
    } catch (err) {
      clearTimeout(tid);
      log('WARNING', 'fetchGoogleAlertsRSS', `Failed: ${query}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log('INFO', 'fetchGoogleAlertsRSS', `Extracted ${alerts.length} alerts`);
  return alerts;
}

// ---------------------------------------------------------------------------
// Source 3: NDMA API (optional)
// ---------------------------------------------------------------------------

interface NdmaWarning {
  title?:    string;
  severity?: string;
  district?: string;
  state?:    string;
  type?:     string;
}

async function fetchNDMAAPI(): Promise<ParsedAlert[]> {
  const ndmaUrl = process.env['NDMA_API_URL'];
  if (!ndmaUrl) return [];

  const alerts:     ParsedAlert[] = [];
  const controller  = new AbortController();
  const tid         = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(ndmaUrl, {
      signal:  controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(tid);
    if (!res.ok) return alerts;

    const data = (await res.json()) as { warnings?: NdmaWarning[] };
    for (const w of data.warnings ?? []) {
      const sev = (w.severity ?? '').toUpperCase();
      if (sev !== 'RED' && sev !== 'ORANGE') continue;
      const district = w.district ?? '';
      if (!district) continue;
      alerts.push({
        colorCode:  sev === 'RED' ? IMDColorCode.RED : IMDColorCode.ORANGE,
        alertType:  inferDisasterType(w.type ?? w.title ?? ''),
        districts:  [district],
        state:      w.state ?? inferState([district]),
        headline:   (w.title ?? `${sev} alert — ${district}`).slice(0, 200),
        details:    JSON.stringify(w).slice(0, 500),
        rawPayload: JSON.stringify(data).slice(0, 2_000),
        source:     'NDMA_API',
      });
    }
    log('INFO', 'fetchNDMAAPI', `Extracted ${alerts.length} NDMA warnings`);
  } catch (err) {
    clearTimeout(tid);
    log('WARNING', 'fetchNDMAAPI', 'Source failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Consecutive-failure admin alert
// ---------------------------------------------------------------------------

const HEALTH_DOC = 'config/pollerHealth';
const FAILURE_THRESHOLD = 3;

async function recordHealth(
  db:       FirebaseFirestore.Firestore,
  hasData:  boolean,
): Promise<void> {
  const ref  = db.doc(HEALTH_DOC);
  const snap = await ref.get();
  const prev = (snap.data() ?? {}) as {
    consecutiveEmptyRuns?: number;
    adminAlerted?: boolean;
  };

  const runs = hasData ? 0 : (prev.consecutiveEmptyRuns ?? 0) + 1;
  await ref.set(
    { consecutiveEmptyRuns: runs, lastRunAt: new Date().toISOString() },
    { merge: true },
  );

  if (runs >= FAILURE_THRESHOLD && !prev.adminAlerted) {
    log('CRITICAL', 'pollerHealth', `${runs} consecutive empty runs — check connectivity`, { runs });
    try {
      const { getMessaging } = await import('firebase-admin/messaging');
      await getMessaging().send({
        topic: 'admin-alerts',
        notification: {
          title: '🔴 IMD Poller Failure',
          body:  `Alert polling returned no data for ${runs} consecutive runs.`,
        },
        data: { type: 'POLLER_FAILURE', runs: String(runs) },
      });
    } catch { /* non-fatal */ }
    await ref.set({ adminAlerted: true }, { merge: true });
  }

  if (hasData && prev.adminAlerted) {
    await ref.set({ adminAlerted: false }, { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Scheduled poller export
// ---------------------------------------------------------------------------

export const pollIMDAlerts = onSchedule(
  {
    schedule:       'every 15 minutes',
    timeZone:       'Asia/Kolkata',
    region:         'asia-south1',
    memory:         '512MiB',
    timeoutSeconds: 300,
  },
  async () => {
    const runId = Date.now().toString(36);
    log('INFO', 'pollIMDAlerts', 'Run started', { runId });

    const db = getFirestore();

    // Fetch all sources concurrently — failures are isolated.
    const [imd, google, ndma] = await Promise.all([
      fetchIMDRSS(),
      fetchGoogleAlertsRSS(),
      fetchNDMAAPI(),
    ]);

    const raw     = [...imd, ...google, ...ndma];
    const hasData = raw.length > 0;

    log('INFO', 'pollIMDAlerts', 'Sources fetched', {
      imd: imd.length, google: google.length, ndma: ndma.length,
    });

    await recordHealth(db, hasData);

    if (!hasData) {
      log('INFO', 'pollIMDAlerts', 'No alerts — run complete', { runId });
      return;
    }

    // Deduplicate across sources (same type + district + today).
    const seenHashes = new Set<string>();
    const unique: Array<ParsedAlert & { dedupHash: string }> = [];

    for (const alert of raw) {
      for (const district of alert.districts) {
        const h = dedupHash(alert.alertType, district, todayISO());
        if (seenHashes.has(h)) continue;
        seenHashes.add(h);
        unique.push({ ...alert, districts: [district], dedupHash: h });
      }
    }

    log('INFO', 'pollIMDAlerts', `${unique.length} unique alerts after dedup`, { runId });

    let newAlerts = 0;

    for (const alert of unique) {
      if (alert.colorCode !== IMDColorCode.RED && alert.colorCode !== IMDColorCode.ORANGE) continue;

      try {
        // Idempotency check — has this exact alert been processed today?
        const existing = await db
          .collection('imdAlerts')
          .where('dedupHash', '==', alert.dedupHash)
          .limit(1)
          .get();

        if (!existing.empty) {
          log('INFO', 'pollIMDAlerts', 'Duplicate skipped', {
            dedupHash: alert.dedupHash, district: alert.districts[0],
          });
          continue;
        }

        const bbox = getBoundingBox(alert.districts);

        // Write the IMDAlert document.
        const alertRef  = db.collection('imdAlerts').doc();
        const imdAlert: Omit<IMDAlert, 'id'> = {
          dedupHash:           alert.dedupHash,
          colorCode:           alert.colorCode,
          alertType:           alert.alertType,
          districts:           alert.districts,
          state:               alert.state,
          headline:            alert.headline,
          details:             alert.details,
          issuedAt:            Timestamp.now(),
          validUntil:          Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1_000),
          source:              alert.source,
          rawPayload:          alert.rawPayload,
          activationTriggered: false,
        };

        await alertRef.set(imdAlert);
        newAlerts++;

        log('INFO', 'pollIMDAlerts', 'Alert stored', {
          id: alertRef.id, colorCode: alert.colorCode, district: alert.districts[0],
        });

        if (alert.colorCode === IMDColorCode.RED) {
          await activateDisasterMode(
            { ...imdAlert, id: alertRef.id } as IMDAlert,
            bbox,
          );
          await alertRef.update({ activationTriggered: true });
        }
      } catch (err) {
        log('ERROR', 'pollIMDAlerts', 'Alert processing failed', {
          dedupHash: alert.dedupHash,
          error:     err instanceof Error ? err.message : String(err),
        });
        // Continue with remaining alerts — per-alert error isolation.
      }
    }

    log('INFO', 'pollIMDAlerts', 'Run complete', { runId, newAlerts });
  },
);
