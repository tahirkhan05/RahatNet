'use client';

/**
 * SwUpdateBanner — "New version available" prompt.
 *
 * When a new service worker is waiting (i.e. a fresh build was deployed
 * while the user had the app open), this banner slides in at the bottom
 * offering a one-tap reload.
 *
 * Calling `applyUpdate()` from useServiceWorker:
 *   1. Posts SKIP_WAITING to the waiting SW.
 *   2. Listens for `controllerchange`.
 *   3. Calls `window.location.reload()` — the page boots with the new SW.
 *
 * Placed at the bottom so it does not overlap the OfflineBanner (which
 * appears at the top) or the citizen report form's submit button.
 */

import * as React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useServiceWorker } from '@/hooks/useServiceWorker';
import { useRouter } from 'next/navigation';

export function SwUpdateBanner() {
  const router = useRouter();
  const { updateAvailable, applyUpdate } = useServiceWorker({
    // Navigate to the right page when the user taps a notification.
    onNotificationClick: (url) => {
      router.push(url);
    },
  });

  const [dismissed, setDismissed] = React.useState(false);
  const [visible,   setVisible]   = React.useState(false);

  // Animate in after `updateAvailable` flips.
  React.useEffect(() => {
    if (updateAvailable && !dismissed) {
      const id = setTimeout(() => setVisible(true), 16);
      return () => clearTimeout(id);
    } else {
      setVisible(false);
    }
    return undefined;
  }, [updateAvailable, dismissed]);

  if (!updateAvailable || dismissed) return null;

  return (
    <div
      aria-live="polite"
      role="status"
      className={[
        'fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-sm',
        'rounded-xl border border-border bg-card p-4 shadow-lg',
        'flex items-center gap-3',
        'transition-all duration-300',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
      ].join(' ')}
    >
      <RefreshCw className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">Update available</p>
        <p className="text-xs text-muted-foreground">Reload to get the latest version.</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={applyUpdate}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notification"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
