'use client';

/**
 * ReportPageClient — the client-side shell for /citizen/report.
 *
 * Responsibilities:
 *  - Auth guard: redirects to /login if the user is not authenticated.
 *  - Error boundary: wraps NeedReportForm so an unexpected crash shows
 *    a recovery UI instead of a blank screen.
 *  - Toast notifications: success and offline-queue toasts.
 *  - Success state: shown after a report is submitted (online or queued).
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  WifiOff,
  ClipboardList,
  Plus,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { NeedReportForm } from './NeedReportForm';
import { t } from '@/lib/i18n/t';

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ReportErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ReportErrorBoundary]', error, info.componentStack);
  }

  private readonly handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="flex flex-col items-center gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"
        >
          <AlertCircle className="h-10 w-10 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-semibold text-foreground">Something went wrong</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The form encountered an unexpected error. Your data has not been lost.
            </p>
          </div>
          <button
            onClick={this.handleReset}
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('common.retry')}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Toast (lightweight — no external dep for this single use case)
// ---------------------------------------------------------------------------

interface ToastMessage {
  id: string;
  type: 'success' | 'offline' | 'error';
  message: string;
}

function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  React.useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), 5_000);
    return () => clearTimeout(id);
  }, [toast.id, onDismiss]);

  const variants = {
    success: 'border-success/30 bg-success/5 text-success',
    offline: 'border-warning/30 bg-warning/5 text-foreground',
    error: 'border-destructive/30 bg-destructive/5 text-destructive',
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg animate-slide-in ${variants[toast.type]}`}
    >
      {toast.type === 'success' && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {toast.type === 'offline' && <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {toast.type === 'error' && <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {toast.message}
    </div>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-label="Notifications"
      className="fixed bottom-6 left-4 right-4 z-50 mx-auto flex max-w-md flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Success screen
// ---------------------------------------------------------------------------

function SuccessScreen({
  reportId,
  wasQueued,
  onReportAnother,
  onViewStatus,
}: {
  reportId: string;
  wasQueued: boolean;
  onReportAnother: () => void;
  onViewStatus: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-6 py-6 text-center">
      <div
        className={[
          'flex h-20 w-20 items-center justify-center rounded-full',
          wasQueued ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success',
        ].join(' ')}
        aria-hidden="true"
      >
        {wasQueued ? (
          <WifiOff className="h-10 w-10" />
        ) : (
          <CheckCircle2 className="h-10 w-10" />
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">
          {wasQueued ? 'Report saved offline' : t('report.success.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {wasQueued
            ? 'Your report is saved and will be sent automatically when you reconnect.'
            : t('report.success.body')}
        </p>
        {!wasQueued && (
          <p className="font-mono text-xs text-muted-foreground">
            {t('report.success.id', { id: reportId.slice(0, 8).toUpperCase() })}
          </p>
        )}
      </div>

      <div className="flex w-full flex-col gap-3">
        <button
          type="button"
          onClick={onViewStatus}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ClipboardList className="h-4 w-4" aria-hidden="true" />
          {t('report.success.track')}
        </button>

        <button
          type="button"
          onClick={onReportAnother}
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('report.success.new')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

type PageState =
  | { view: 'loading' }
  | { view: 'form' }
  | { view: 'success'; reportId: string; wasQueued: boolean };

export function ReportPageClient() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated } = useAuth();
  const [pageState, setPageState] = React.useState<PageState>({ view: 'loading' });
  const [toasts, setToasts] = React.useState<ToastMessage[]>([]);

  const addToast = (type: ToastMessage['type'], message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
  };

  const dismissToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auth guard.
  React.useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace('/login?redirect=/citizen/report');
      return;
    }
    setPageState({ view: 'form' });
  }, [isLoading, isAuthenticated, router]);

  const handleSuccess = (reportId: string, wasQueued: boolean) => {
    setPageState({ view: 'success', reportId, wasQueued });
    addToast(
      wasQueued ? 'offline' : 'success',
      wasQueued
        ? 'Report saved. Will be sent when you reconnect.'
        : 'Report submitted successfully!',
    );
  };

  // ---- Loading ----
  if (pageState.view === 'loading' || isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        </div>
      </div>
    );
  }

  // ---- Success ----
  if (pageState.view === 'success') {
    return (
      <>
        <SuccessScreen
          reportId={pageState.reportId}
          wasQueued={pageState.wasQueued}
          onReportAnother={() => setPageState({ view: 'form' })}
          onViewStatus={() => router.push('/citizen/status')}
        />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  // ---- Form ----
  return (
    <>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Report a Need</h1>
          <p className="text-sm text-muted-foreground">Tell us what help is needed</p>
        </div>

        <ReportErrorBoundary>
          {user !== null && (
            <NeedReportForm
              userId={user.uid}
              onSuccess={handleSuccess}
            />
          )}
        </ReportErrorBoundary>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
