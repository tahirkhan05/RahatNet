/**
 * Vertex AI client for RahatNet urgency scoring.
 *
 * Design rationale:
 *   Phase 1 (current): Gemini-based three-signal scoring is the primary path.
 *   Phase 2 (future):  A fine-tuned Vertex AI model trained on labeled
 *     RahatNet score history replaces the hand-tuned weights.
 *
 * This module provides:
 *
 *   callVertexAI(prompt)
 *     Raw text generation via a Vertex AI endpoint (PaLM 2 / Gemini on Vertex).
 *     Falls back to Gemini API if the endpoint is not configured.
 *
 *   predictWithVertexModel(features)
 *     Returns an urgency score [1–10].
 *     If a Vertex AI custom model endpoint is configured in env vars,
 *     sends a feature vector to it.  Otherwise falls back to the local
 *     urgency.ts formula (Gemini + deterministic signals).
 *
 *   trainUrgencyModel()
 *     STUB — exports historical score records from Firestore and submits
 *     a fine-tuning job to Vertex AI AutoML (Tabular).
 *     Returns a training job ID for monitoring.
 *     Currently logs the steps it WOULD take — activating requires
 *     a labeled dataset of ≥ 1000 scored needs.
 *
 * Environment variables (all optional — falls back gracefully when absent):
 *   GOOGLE_CLOUD_PROJECT_ID     — GCP project containing the Vertex endpoint
 *   GOOGLE_CLOUD_LOCATION       — Region, e.g. 'asia-south1'
 *   VERTEX_AI_ENDPOINT          — Full resource name of the deployed endpoint
 *                                  format: projects/{p}/locations/{l}/endpoints/{e}
 *   VERTEX_URGENCY_ENDPOINT_ID  — Short endpoint ID (alternative to full name)
 *
 * Server-only: never import from 'use client' components.
 */

import { callGeminiWithAudit, callGeminiText, GEMINI_MODEL } from './gemini';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Feature vector passed to the Vertex AI urgency model.
 * All fields are numeric or boolean so they can be sent as a tabular
 * prediction request (AutoML Tabular or custom sklearn/tf model).
 */
export interface UrgencyFeatures {
  /** Report descriptions joined into one string for text embedding. */
  readonly descriptions:    readonly string[];
  /** Total people affected (integer). */
  readonly affectedCount:   number;
  /** Whether a vulnerable person is present. */
  readonly hasVulnerable:   boolean;
  /** Number of distinct citizens who reported the same incident. */
  readonly reportCount:     number;
  /** Unix ms timestamp of the first report. */
  readonly firstReportedAt: number;
  /** Optional photo for multi-modal models. */
  readonly photoBase64:     string | null;
}

/** Vertex AI prediction response shape (custom endpoint). */
interface VertexPredictionResponse {
  readonly predictions: ReadonlyArray<{
    readonly urgencyScore?: number;
    readonly score?:        number;
  }>;
}

/** Vertex AI training job creation response. */
export interface TrainingJobResult {
  /** Vertex AI training job resource name. */
  readonly jobName:      string;
  readonly status:       'SUBMITTED' | 'SKIPPED' | 'ERROR';
  readonly message:      string;
  readonly datasetRows?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getVertexConfig(): {
  projectId: string | null;
  location:  string;
  endpoint:  string | null;
} {
  return {
    projectId: process.env['GOOGLE_CLOUD_PROJECT_ID']    ?? null,
    location:  process.env['GOOGLE_CLOUD_LOCATION']       ?? 'asia-south1',
    endpoint:  process.env['VERTEX_AI_ENDPOINT']          ??
               buildEndpointName(
                 process.env['GOOGLE_CLOUD_PROJECT_ID'] ?? null,
                 process.env['GOOGLE_CLOUD_LOCATION']   ?? 'asia-south1',
                 process.env['VERTEX_URGENCY_ENDPOINT_ID'] ?? null,
               ),
  };
}

function buildEndpointName(
  projectId:  string | null,
  location:   string,
  endpointId: string | null,
): string | null {
  if (!projectId || !endpointId) return null;
  return `projects/${projectId}/locations/${location}/endpoints/${endpointId}`;
}

function isVertexConfigured(): boolean {
  const { projectId, endpoint } = getVertexConfig();
  return projectId !== null && endpoint !== null;
}

// ---------------------------------------------------------------------------
// callVertexAI — raw text generation
// ---------------------------------------------------------------------------

/**
 * Call a Vertex AI generative model endpoint with a text prompt.
 *
 * Tries the Vertex AI API first; falls back to Gemini API if:
 *   - No endpoint is configured in env vars.
 *   - The Vertex call fails (network error, quota, etc.)
 *
 * @param prompt   The instruction prompt.
 * @returns        Generated text response.
 */
export async function callVertexAI(prompt: string): Promise<string> {
  const { projectId, location, endpoint } = getVertexConfig();

  if (projectId !== null && endpoint !== null) {
    try {
      return await callVertexEndpoint(projectId, location, endpoint, prompt);
    } catch (err) {
      // Fall through to Gemini fallback.
      console.warn('[Vertex] Endpoint call failed, falling back to Gemini:', err instanceof Error ? err.message : String(err));
    }
  }

  // Gemini fallback.
  const result = await callGeminiText(prompt);
  return result.text;
}

/** Make a raw REST call to a Vertex AI text generation endpoint. */
async function callVertexEndpoint(
  projectId: string,
  location:  string,
  endpoint:  string,
  prompt:    string,
): Promise<string> {
  // Use Application Default Credentials (ADC) — available when running on
  // Cloud Run / GCE / GKE with the Vertex AI service account attached.
  const { GoogleAuth } = await import('google-auth-library');
  const auth  = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();

  const url  = `https://${location}-aiplatform.googleapis.com/v1/${endpoint}:predict`;
  const body = {
    instances:  [{ content: prompt }],
    parameters: { temperature: 0.1, maxOutputTokens: 1024 },
  };

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Vertex API returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { predictions?: Array<{ content?: string }> };
  return data.predictions?.[0]?.content ?? '';
}

// ---------------------------------------------------------------------------
// predictWithVertexModel — urgency score prediction
// ---------------------------------------------------------------------------

/**
 * Predict an urgency score [1–10] from a feature vector.
 *
 * Strategy:
 *   1. If a Vertex AI custom model endpoint is configured, call it.
 *   2. Otherwise, run the local urgency formula (keyword + photo + context).
 *
 * The caller (urgency.ts: calculateWithVertex) handles the Gemini fallback
 * at a higher level — this function only needs to return a number.
 *
 * @param features  Feature vector for the need being scored.
 * @returns         Urgency score [1.0–10.0] (floating point, caller rounds).
 */
export async function predictWithVertexModel(features: UrgencyFeatures): Promise<number> {
  if (!isVertexConfigured()) {
    // No Vertex model deployed — run local formula.
    return computeLocalScore(features);
  }

  const { projectId, location, endpoint } = getVertexConfig();

  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth  = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();

    const url = `https://${location}-aiplatform.googleapis.com/v1/${endpoint!}:predict`;

    // Build a tabular feature vector.
    // Text features are hashed/embedded server-side by the model.
    const instance = {
      description_text: features.descriptions.join(' ').slice(0, 2000),
      affected_count:   features.affectedCount,
      has_vulnerable:   features.hasVulnerable ? 1 : 0,
      report_count:     features.reportCount,
      age_hours:        (Date.now() - features.firstReportedAt) / (1000 * 60 * 60),
    };

    const response = await fetch(url, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body:   JSON.stringify({ instances: [instance] }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Vertex predict returned ${response.status}`);
    }

    const data    = (await response.json()) as VertexPredictionResponse;
    const raw     = data.predictions?.[0]?.urgencyScore ?? data.predictions?.[0]?.score;
    const numeric = typeof raw === 'number' ? raw : parseFloat(String(raw));

    if (!Number.isFinite(numeric)) throw new Error('Vertex returned non-numeric prediction');

    return Math.max(1, Math.min(10, numeric));
  } catch (err) {
    console.warn('[Vertex] predictWithVertexModel failed, using local formula:', err instanceof Error ? err.message : String(err));
    return computeLocalScore(features);
  }
}

/**
 * Local fallback score computation — mirrors the urgency.ts formula
 * without the async photo call (which would require an extra Gemini round-trip).
 * Photo scoring is omitted here because the caller (vertex path in urgency.ts)
 * runs photo scoring separately for the factors breakdown.
 */
function computeLocalScore(features: UrgencyFeatures): number {
  // Keyword signal (synchronous).
  const { scoreByKeywordsSync } = require('./urgency') as { scoreByKeywordsSync: (text: string) => { score: number } };
  const keywordScore = scoreByKeywordsSync(features.descriptions.join(' ')).score;

  // Context signal.
  const { scoreByContext } = require('./urgency') as { scoreByContext: (s: { affectedCount: number; hasVulnerable: boolean; reportCount: number; firstReportedAt: number }) => { total: number } };
  const contextScore = scoreByContext({
    affectedCount:   features.affectedCount,
    hasVulnerable:   features.hasVulnerable,
    reportCount:     features.reportCount,
    firstReportedAt: features.firstReportedAt,
  }).total;

  // Photo signal defaults to 5 (neutral) when not scoring here.
  const photoScore = 5;

  return Math.max(1, Math.min(10, keywordScore * 0.35 + photoScore * 0.30 + contextScore * 0.35));
}

// ---------------------------------------------------------------------------
// trainUrgencyModel — STUB for Phase 2
// ---------------------------------------------------------------------------

/**
 * Export historical urgency score records from Firestore and submit
 * a Vertex AI AutoML Tabular fine-tuning job.
 *
 * STATUS: STUB — logs the steps it WOULD take in Phase 2.
 *
 * Activation requirements:
 *   1. ≥ 1,000 scored canonical needs in /urgencyScoreHistory
 *   2. A labeled dataset with human-validated urgency scores
 *   3. A Vertex AI Dataset resource (create via GCP Console or gcloud)
 *   4. VERTEX_DATASET_ID set in env vars
 *
 * When active, the pipeline would:
 *   1. Query /urgencyScoreHistory ordered by computedAt descending, limit 5000.
 *   2. Export records to BigQuery (rahatnet_analytics.urgency_training_data).
 *   3. Create a Vertex AI Dataset from the BigQuery export.
 *   4. Submit an AutoML Tabular training job targeting the `score` column.
 *   5. Return the training job resource name for monitoring.
 *
 * @returns TrainingJobResult with status 'SKIPPED' until Phase 2 is activated.
 */
export async function trainUrgencyModel(): Promise<TrainingJobResult> {
  const datasetId = process.env['VERTEX_DATASET_ID'];

  if (!isVertexConfigured() || !datasetId) {
    console.info(
      '[Vertex:trainUrgencyModel] STUB — not yet activated.\n' +
        'To activate Phase 2 training:\n' +
        '  1. Set VERTEX_DATASET_ID, GOOGLE_CLOUD_PROJECT_ID, VERTEX_URGENCY_ENDPOINT_ID in .env\n' +
        '  2. Ensure /urgencyScoreHistory has ≥ 1000 records\n' +
        '  3. Remove the early return in this function and implement the BigQuery export step',
    );
    return {
      jobName: '',
      status:  'SKIPPED',
      message: 'Vertex AI training not configured. See console for activation steps.',
    };
  }

  // ── Phase 2 implementation (currently unreachable) ──────────────────────

  try {
    const { adminFirestore } = await import('@/lib/firebase/admin');
    const { GoogleAuth }     = await import('google-auth-library');
    const { projectId, location } = getVertexConfig();

    // Step 1: Count training examples.
    const countSnap = await adminFirestore.collection('urgencyScoreHistory').count().get();
    const rowCount  = countSnap.data().count;

    if (rowCount < 100) {
      return {
        jobName:      '',
        status:       'SKIPPED',
        message:      `Only ${rowCount} training examples — minimum 100 required.`,
        datasetRows:  rowCount,
      };
    }

    // Step 2: Submit AutoML Tabular training job.
    const auth  = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();

    const jobBody = {
      displayName: `rahatnet-urgency-training-${Date.now()}`,
      trainingTaskDefinition:
        'gs://google-cloud-aiplatform/schema/trainingjob/definition/automl_tabular_1.0.0.yaml',
      trainingTaskInputs: {
        targetColumn:   'score',
        datasetId,
        transformations: [
          { text:    { columnName: 'description_text' } },
          { numeric: { columnName: 'affected_count'   } },
          { numeric: { columnName: 'has_vulnerable'   } },
          { numeric: { columnName: 'report_count'     } },
          { numeric: { columnName: 'age_hours'        } },
        ],
        predictionType: 'regression',
        trainBudgetMilliNodeHours: 1000,  // 1 node-hour
      },
      modelToUpload: {
        displayName: `rahatnet-urgency-model-${Date.now()}`,
      },
    };

    const trainUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/trainingPipelines`;
    const res = await fetch(trainUrl, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(jobBody),
    });

    if (!res.ok) {
      throw new Error(`Training job submission failed: ${res.status} ${await res.text()}`);
    }

    const job = (await res.json()) as { name: string };
    return {
      jobName:     job.name,
      status:      'SUBMITTED',
      message:     `Training job submitted. Monitor at: https://console.cloud.google.com/vertex-ai/training`,
      datasetRows: rowCount,
    };
  } catch (err) {
    return {
      jobName: '',
      status:  'ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
