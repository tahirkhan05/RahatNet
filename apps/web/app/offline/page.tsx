/**
 * Offline fallback page — served by the service worker when the user
 * navigates to any page while offline and no cached version exists.
 *
 * This is a static page (no data fetching) so it can always be served
 * from the precache regardless of network state.
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline',
};

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      {/* Icon */}
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-10 w-10 text-muted-foreground"
          aria-hidden="true"
        >
          {/* Wifi-off icon */}
          <line x1={1} y1={1} x2={23} y2={23} />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1={12} y1={20} x2={12.01} y2={20} />
        </svg>
      </div>

      {/* Copy */}
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">You&apos;re offline</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          RahatNet needs a connection to load this page. Any reports you submit
          while offline are saved locally and will be sent automatically when
          you reconnect.
        </p>
      </div>

      {/* Retry */}
      <button
        onClick={() => {
          window.location.reload();
        }}
        className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Try again
      </button>
    </div>
  );
}
