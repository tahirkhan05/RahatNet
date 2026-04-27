export const APP_NAME = 'RahatNet';

export const SUPPORTED_LANGUAGES = [
  { code: 'hi', name: 'Hindi', nativeName: 'हिंदी' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
  { code: 'en', name: 'English', nativeName: 'English' },
] as const;

/** GPS clustering radius in meters */
export const GPS_CLUSTER_RADIUS_M = 200;

/** Deduplication batch size for Gemini */
export const AI_BATCH_SIZE = 50;

/** Max Gemini calls per minute */
export const GEMINI_RATE_LIMIT_PER_MIN = 60;

/** Target response time in minutes */
export const TARGET_RESPONSE_TIME_MINUTES = 8;

/** Auto-decline timeout for volunteer task acceptance */
export const TASK_ACCEPT_TIMEOUT_MS = 60_000;

/** Urgency thresholds */
export const URGENCY_THRESHOLDS = {
  CRITICAL: 8,
  URGENT: 5,
  NORMAL: 3,
} as const;
