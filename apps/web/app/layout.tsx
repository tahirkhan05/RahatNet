/**
 * Root layout — the single HTML shell shared by every page in the app.
 *
 * Provider composition (outer → inner):
 *   ThemeProvider        – next-themes, class-based, system default
 *   FirebaseProvider     – initialises Firebase SDK client-side
 *   QueryProvider        – TanStack Query v5 client + DevTools (dev only)
 *   AuthProvider         – syncs Firebase Auth state → Zustand store
 *   GlobalErrorBoundary  – catches any render error below this point
 *
 * Google Analytics is injected with `strategy="lazyOnload"` so it does not
 * block the main thread during page load.  The gtag consent mode is set to
 * "denied" by default to satisfy GDPR; actual consent is granted when the
 * user accepts the cookie banner (Phase 2+).
 */

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';

import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { FirebaseProvider } from '@/components/providers/FirebaseProvider';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { GlobalErrorBoundary } from '@/components/providers/ErrorBoundary';
import { OfflineBanner } from '@/components/shared/OfflineBanner';
import { SwUpdateBanner } from '@/components/shared/SwUpdateBanner';
import { LanguageProvider } from '@/lib/i18n/LanguageContext';

import './globals.css';

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

/**
 * Inter is loaded via next/font so it is self-hosted, avoiding a render-
 * blocking request to fonts.googleapis.com on first load.
 * The `variable` prop injects a CSS custom property (`--font-sans`) that
 * Tailwind's `font-sans` utility reads.
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  // Preload the two most common weights to reduce CLS.
  weight: ['400', '500', '600', '700'],
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** @see https://nextjs.org/docs/app/api-reference/functions/generate-metadata */
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://rahatnet.web.app',
  ),

  // All child pages export `export const metadata = { title: 'Page name' }`
  // which gets interpolated into this template.
  title: {
    template: 'RahatNet | %s',
    default: 'RahatNet — AI Disaster Coordination',
  },

  description:
    'Real-time AI-powered disaster coordination for India. Report needs, dispatch volunteers, save lives.',

  keywords: [
    'disaster relief',
    'flood response',
    'India',
    'AI coordination',
    'NGO',
    'NDRF',
    'volunteer dispatch',
  ],

  authors: [{ name: 'RahatNet' }],

  // Open Graph
  openGraph: {
    type: 'website',
    locale: 'en_IN',
    url: process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://rahatnet.web.app',
    siteName: 'RahatNet',
    title: 'RahatNet — AI Disaster Coordination',
    description:
      'AI de-duplication · Volunteer dispatch · War-room dashboard. Built for Indian flood response.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'RahatNet — AI Disaster Coordination Platform',
      },
    ],
  },

  // Twitter / X
  twitter: {
    card: 'summary_large_image',
    title: 'RahatNet — AI Disaster Coordination',
    description: 'Real-time AI coordination for disaster relief in India.',
    images: ['/og-image.png'],
  },

  // PWA
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'RahatNet',
    startupImage: [
      { url: '/icons/splash-2048x2732.png', media: '(device-width: 1024px)' },
    ],
  },

  // Prevent iOS from auto-linking phone numbers (we handle tel: links ourselves).
  formatDetection: { telephone: false, email: false },

  // Bots
  robots: {
    index: process.env['NEXT_PUBLIC_ENV'] === 'production',
    follow: process.env['NEXT_PUBLIC_ENV'] === 'production',
  },
};

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export const viewport: Viewport = {
  themeColor: [
    // Match the PWA theme colour in both modes so the browser chrome adapts.
    { media: '(prefers-color-scheme: light)', color: '#F27527' },
    { media: '(prefers-color-scheme: dark)', color: '#1A1917' },
  ],
  width: 'device-width',
  initialScale: 1,
  // Allow users to zoom for accessibility — do not set maximumScale: 1.
  maximumScale: 5,
  userScalable: true,
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  const gaMeasurementId = process.env['NEXT_PUBLIC_GA_MEASUREMENT_ID'];

  return (
    <html
      lang="en"
      // Suppressed to prevent the flash caused by next-themes injecting the
      // `dark` class on the server vs client.
      suppressHydrationWarning
    >
      <head>
        {/*
         * DNS prefetch for third-party origins loaded in the page so the
         * browser can resolve them before the resources are requested.
         */}
        <link rel="dns-prefetch" href="https://fonts.gstatic.com" />
        <link rel="dns-prefetch" href="https://maps.googleapis.com" />
        <link rel="dns-prefetch" href="https://firebasestorage.googleapis.com" />

        {/* Preconnect to the most latency-sensitive origins. */}
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>

      <body className={`${inter.variable} font-sans antialiased`}>
        {/*
         * GDPR-compliant Google Analytics:
         *
         * 1. The gtag.js script is loaded with `lazyOnload` so it never
         *    blocks rendering or the main thread.
         * 2. Consent mode defaults to "denied" for ad_storage and
         *    analytics_storage.  Once the user accepts the cookie banner
         *    (Phase 2+) call gtag('consent', 'update', ...) to grant.
         * 3. The block is omitted entirely when the measurement ID is absent
         *    (local dev / staging without GA config).
         */}
        {gaMeasurementId !== undefined && gaMeasurementId !== '' && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`}
              strategy="lazyOnload"
            />
            <Script id="ga-consent-init" strategy="lazyOnload">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}

                // GDPR: default to denied — will be updated on user consent.
                gtag('consent', 'default', {
                  ad_storage: 'denied',
                  analytics_storage: 'denied',
                  wait_for_update: 500
                });

                gtag('js', new Date());
                gtag('config', '${gaMeasurementId}', {
                  page_path: window.location.pathname,
                  send_page_view: false
                });
              `}
            </Script>
          </>
        )}

        {/*
         * Provider stack — each layer wraps everything inside it.
         * Order matters: QueryProvider must be inside FirebaseProvider so
         * queries can use the Firebase client, and AuthProvider must be inside
         * QueryProvider so it can invalidate queries on sign-out.
         */}
        <LanguageProvider>
        <ThemeProvider>
          <FirebaseProvider>
            <QueryProvider>
              <AuthProvider>
                <GlobalErrorBoundary>
                  {/* Sticky network-state banner at the very top of the viewport */}
                  <OfflineBanner />
                  {children}
                  {/* SW update prompt at the bottom, below page content */}
                  <SwUpdateBanner />
                </GlobalErrorBoundary>
              </AuthProvider>
            </QueryProvider>
          </FirebaseProvider>
        </ThemeProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
