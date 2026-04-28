import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { NeedStatus, COLLECTIONS } from '@rahatnet/types';
import type { RawReport } from '@rahatnet/types';

const GPS_CLUSTER_RADIUS_M = 200;

function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clusterByGPS(reports: RawReport[]): RawReport[][] {
  const visited = new Set<number>();
  const clusters: RawReport[][] = [];

  for (let i = 0; i < reports.length; i++) {
    if (visited.has(i)) continue;

    const cluster: RawReport[] = [reports[i] as RawReport];
    visited.add(i);

    for (let j = i + 1; j < reports.length; j++) {
      if (visited.has(j)) continue;
      const ri = reports[i] as RawReport;
      const rj = reports[j] as RawReport;
      const dist = haversineDistance(
        ri.location.lat,
        ri.location.lng,
        rj.location.lat,
        rj.location.lng,
      );
      if (dist <= GPS_CLUSTER_RADIUS_M) {
        cluster.push(rj);
        visited.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters.sort((a, b) => b.length - a.length);
}

export const processReports = onRequest(
  { region: 'us-central1', memory: '1GiB', timeoutSeconds: 300 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const db = getFirestore();
    const geminiKey = process.env['GEMINI_API_KEY'];

    if (!geminiKey) {
      res.status(500).json({ error: 'Gemini API key not configured' });
      return;
    }

    const genAI = new GoogleGenerativeAI(geminiKey);

    const snap = await db
      .collection(COLLECTIONS.RAW_REPORTS)
      .where('status', '==', 'PENDING')
      .limit(50)
      .get();

    const reports = snap.docs.map(
      (d) => ({ id: d.id, ...d.data() }) as RawReport,
    );

    if (reports.length === 0) {
      res.json({ processed: 0, canonical: 0, duplicatesRemoved: 0 });
      return;
    }

    const clusters = clusterByGPS(reports);
    let canonicalCount = 0;
    let duplicatesRemoved = 0;
    const startTime = Date.now();

    for (const cluster of clusters) {
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        const prompt = `You are analyzing disaster reports during a flood emergency in India.

I have ${cluster.length} reports from within 200 meters of each other.
Determine if these are reports about the SAME incident or DIFFERENT incidents.

Reports:
${cluster.map((r, i) => `[${i + 1}] "${r.description}" — ${r.type} — ${r.affectedCount} people`).join('\n')}

Respond ONLY in this JSON format (no other text):
{
  "isSameIncident": boolean,
  "confidence": number between 0 and 1,
  "subClusters": number[][],
  "reasoning": "brief explanation"
}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonText = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
        const parsed = JSON.parse(jsonText) as {
          isSameIncident: boolean;
          confidence: number;
          subClusters: number[][];
        };

        const batch = db.batch();

        if (parsed.isSameIncident) {
          const needRef = db.collection(COLLECTIONS.NEEDS).doc();
          const primaryReport = cluster[0] as RawReport;

          batch.set(needRef, {
            title: `${primaryReport.type} needed at ${primaryReport.locationName} — ${cluster.reduce((s, r) => s + r.affectedCount, 0)} people`,
            description: primaryReport.description,
            type: primaryReport.type,
            status: NeedStatus.VERIFIED,
            severity: 'URGENT',
            urgencyScore: 7,
            location: primaryReport.location,
            locationName: primaryReport.locationName,
            affectedCount: cluster.reduce((s, r) => s + r.affectedCount, 0),
            hasVulnerable: cluster.some((r) => r.hasVulnerable),
            sourceReportIds: cluster.map((r) => r.id),
            reportCount: cluster.length,
            assignedVolunteerId: null,
            assignedAt: null,
            resolvedAt: null,
            disasterEventId: primaryReport.canonicalNeedId ?? 'unknown',
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
            aiProcessingMeta: {
              deduplicationConfidence: parsed.confidence,
              urgencyFactors: {},
              processingTimeMs: Date.now() - startTime,
            },
          });

          cluster.forEach((r, idx) => {
            const reportRef = db.collection(COLLECTIONS.RAW_REPORTS).doc(r.id);
            batch.update(reportRef, {
              status: idx === 0 ? 'PROCESSED' : 'DUPLICATE',
              canonicalNeedId: needRef.id,
            });
          });

          canonicalCount++;
          duplicatesRemoved += cluster.length - 1;
        }

        await batch.commit();
      } catch (err) {
        console.error(`Failed to process cluster of ${cluster.length} reports:`, err);
      }
    }

    res.json({
      processed: reports.length,
      canonical: canonicalCount,
      duplicatesRemoved,
      timing: Date.now() - startTime,
    });
  },
);
