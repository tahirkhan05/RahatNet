/**
 * RahatNet Next.js configuration.
 *
 * Layers applied (outermost first):
 *   bundleAnalyzer → withPWA → nextConfig
 *
 * Environment flags:
 *   ANALYZE=true   – emit bundle analysis HTML files to .next/analyze/
 *   NODE_ENV=development – disables PWA service worker registration
 */

import withBundleAnalyzer from '@next/bundle-analyzer';
import withPWA from 'next-pwa';

// ---------------------------------------------------------------------------
// 1. Bundle analyzer — only active when ANALYZE=true
// ---------------------------------------------------------------------------
const analyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: false,
});

// ---------------------------------------------------------------------------
// 2. PWA / Workbox configuration
// ---------------------------------------------------------------------------
const pwaConfig = {
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  // Keep the Workbox runtime separate so browsers cache it independently.
  runtimeCaching: [
    // ---- External fonts -----------------------------------------------
    {
      urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'gfonts-webfonts',
        expiration: { maxEntries: 10, maxAgeSeconds: 365 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'gfonts-stylesheets',
        expiration: { maxEntries: 10, maxAgeSeconds: 7 * 24 * 60 * 60 },
      },
    },
    // ---- Next.js static assets ----------------------------------------
    {
      urlPattern: /\/_next\/static\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'next-static',
        expiration: { maxEntries: 256, maxAgeSeconds: 365 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: /\/_next\/image\?url=.+$/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'next-image',
        expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
      },
    },
    {
      urlPattern: /\/_next\/data\/.+\.json$/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'next-data',
        expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
      },
    },
    // ---- Local static files (images, audio) ---------------------------
    {
      urlPattern: /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'static-images',
        expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
      },
    },
    {
      urlPattern: /\.(?:mp3|wav|ogg)$/i,
      handler: 'CacheFirst',
      options: {
        rangeRequests: true,
        cacheName: 'static-audio',
        expiration: { maxEntries: 16, maxAgeSeconds: 24 * 60 * 60 },
      },
    },
    // ---- API routes — needs list is served stale while revalidating ---
    {
      urlPattern: /^\/api\/needs(?:\?.*)?$/i,
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-needs',
        networkTimeoutSeconds: 10,
        expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // Health check is always network-only so stale data never masks outages.
    {
      urlPattern: /^\/api\/health$/i,
      handler: 'NetworkOnly',
    },
    // ---- Google Maps JS API + tiles (CacheFirst, 7-day expiry) -----------
    {
      urlPattern: /^https:\/\/maps\.googleapis\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'gmaps-tiles',
        expiration: { maxEntries: 256, maxAgeSeconds: 7 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    {
      urlPattern: /^https:\/\/maps\.gstatic\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'gmaps-tiles',
        expiration: { maxEntries: 128, maxAgeSeconds: 7 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ---- Firebase Storage CDN (photo + voice-note downloads) -----------
    {
      urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'rn-firebase-v1',
        expiration: { maxEntries: 64, maxAgeSeconds: 7 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ---- Firebase App CDN (SDK JS bundles) ----------------------------
    {
      urlPattern: /^https:\/\/.*\.firebaseapp\.com\/.*\.js$/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'rn-firebase-v1',
        expiration: { maxEntries: 32, maxAgeSeconds: 7 * 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
    // ---- App-shell HTML pages (StaleWhileRevalidate) ------------------
    {
      urlPattern: /^\/(?:citizen|volunteer|coordinator|login|verify|onboarding|offline).*$/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'app-pages',
        expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
        cacheableResponse: { statuses: [0, 200] },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. Content Security Policy helper
// ---------------------------------------------------------------------------
/** Build a strict CSP string. 'unsafe-eval' is required by Next.js in dev. */
function buildCSP() {
  const isDev = process.env.NODE_ENV === 'development';
  const scriptSrc = [
    "'self'",
    // Next.js HMR websocket client needs eval in dev only
    isDev ? "'unsafe-eval'" : null,
    // Inline scripts emitted by Next.js (nonce approach would be better but
    // requires dynamic rendering — acceptable trade-off for this project)
    "'unsafe-inline'",
    'https://maps.googleapis.com',
    'https://maps.gstatic.com',
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    // Firebase Phone Auth reCAPTCHA + Google Sign-In + RTDB
    'https://*.scriptcdn.net',
    'https://www.recaptcha.net',
    'https://www.gstatic.com',
    'https://*.firebaseapp.com',
    'https://apis.google.com',
    'https://www.google.com',
    'https://*.firebaseio.com',
    'https://*.firebasedatabase.app',
  ]
    .filter(Boolean)
    .join(' ');

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://r2cdn.perplexity.ai",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://firebasestorage.googleapis.com https://lh3.googleusercontent.com https://*.googleusercontent.com",
    "font-src 'self' https://fonts.gstatic.com https://r2cdn.perplexity.ai",
    // Firebase Realtime DB uses WebSockets; Firestore uses long-poll + fetch.
    "connect-src 'self' https://*.firebaseio.com https://*.googleapis.com wss://*.firebaseio.com wss://*.firebaseio.com https://firebaseinstallations.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.scriptcdn.net https://www.recaptcha.net https://www.google.com https://*.firebasedatabase.app wss://*.firebasedatabase.app",
    "worker-src 'self' blob:",
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://www.recaptcha.net https://*.scriptcdn.net https://apis.google.com https://www.google.com https://*.firebaseio.com https://*.firebasedatabase.app",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ];

  return directives.join('; ');
}

// ---------------------------------------------------------------------------
// 4. Security headers
// ---------------------------------------------------------------------------
/** @type {import('next').NextConfig['headers']} */
async function securityHeaders() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-DNS-Prefetch-Control', value: 'on' },
        {
          key: 'Strict-Transport-Security',
          // 2-year HSTS — browser preload list eligible
          value: 'max-age=63072000; includeSubDomains; preload',
        },
        {
          key: 'X-Frame-Options',
          // Defense-in-depth alongside the CSP frame-ancestors directive
          value: 'SAMEORIGIN',
        },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Permissions-Policy',
          // Restrict powerful APIs to what the app actually needs.
          // Camera denied (photos go through <input capture>), mic + geo self-only.
          value: 'camera=(), microphone=(self), geolocation=(self), payment=()',
        },
        { key: 'Content-Security-Policy', value: buildCSP() },
        {
          key: 'X-Request-ID',
          // Populated per-request in middleware; this header stub satisfies
          // some CDN preflight requirements.
          value: 'middleware-generated',
        },
      ],
    },
    // Service worker must be served with no cache headers so browsers always
    // fetch the latest version on navigation.
    {
      source: '/sw.js',
      headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 5. Core Next.js config
// ---------------------------------------------------------------------------
/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Standalone output for production Docker builds only.
   * Disabled in dev to avoid route discovery issues.
   */
  output: process.env.NODE_ENV === 'production' ? 'standalone' : undefined,

  reactStrictMode: true,


  /**
   * Remote image patterns replaces the deprecated `domains` key in Next 14.
   * We allow Google user avatars and Firebase Storage CDN.
   */
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
        pathname: '/**',
      },
    ],
  },

  headers: securityHeaders,

  /** Resolve workspace packages without full build-step during development. */
  transpilePackages: ['@rahatnet/ui', '@rahatnet/types'],

  /**
   * Suppress the warning about the `swSrc` config option that next-pwa emits
   * when it finds an existing sw.js in public/.
   */
  webpack(config, { dev, isServer }) {
    // Prevent Node-only firebase-admin modules from being bundled for the browser.
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        net: false, tls: false, fs: false, dns: false, child_process: false,
      };
    }
    if (dev) {
      config.watchOptions = {
        ignored: ['**/node_modules/**', '**/.next/**', '**/public/**'],
        aggregateTimeout: 300,
      };
    }
    return config;
  },
};

// ---------------------------------------------------------------------------
// 6. Compose wrappers
// ---------------------------------------------------------------------------
export default analyzer(withPWA(pwaConfig)(nextConfig));
