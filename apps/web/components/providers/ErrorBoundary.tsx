'use client';

/**
 * GlobalErrorBoundary is a React class component — the only way to catch
 * render-phase errors in React 18.
 *
 * It renders a full-page recovery UI when an unhandled error is thrown
 * anywhere in the React tree below it.  The user sees a human-readable
 * message and can reload or navigate home without losing session state.
 *
 * Usage in layout.tsx:
 *   <GlobalErrorBoundary>
 *     {children}
 *   </GlobalErrorBoundary>
 */

import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** Unique key used to reset the boundary after the user dismisses. */
  recoveryKey: number;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional custom fallback rendered instead of the default recovery UI. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

export class GlobalErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, recoveryKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // In production this should be wired to your error-tracking service.
    console.error('[GlobalErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      recoveryKey: prev.recoveryKey + 1,
    }));
  };

  override render(): React.ReactNode {
    const { hasError, error, recoveryKey } = this.state;
    const { children, fallback } = this.props;

    if (!hasError || error === null) {
      // recoveryKey forces a full remount of the subtree after reset so stale
      // state in descendants doesn't cause an immediate re-throw.
      return <React.Fragment key={recoveryKey}>{children}</React.Fragment>;
    }

    if (fallback !== undefined) {
      return fallback(error, this.handleReset);
    }

    return <DefaultErrorUI error={error} onReset={this.handleReset} />;
  }
}

// ---------------------------------------------------------------------------
// Default recovery UI
// ---------------------------------------------------------------------------

interface DefaultErrorUIProps {
  error: Error;
  onReset: () => void;
}

function DefaultErrorUI({ error, onReset }: DefaultErrorUIProps) {
  const isDev = process.env.NODE_ENV === 'development';

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center"
    >
      {/* Icon */}
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-8 w-8"
          aria-hidden="true"
        >
          <circle cx={12} cy={12} r={10} />
          <line x1={12} y1={8} x2={12} y2={12} />
          <line x1={12} y1={16} x2={12.01} y2={16} />
        </svg>
      </div>

      {/* Heading */}
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          An unexpected error occurred. Your session is intact — try reloading the page.
        </p>
      </div>

      {/* Dev-only stack trace */}
      {isDev && (
        <details className="max-w-xl rounded-lg border border-border bg-card p-4 text-left">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            {error.name}: {error.message}
          </summary>
          <pre className="mt-2 overflow-auto text-xs text-muted-foreground">
            {error.stack}
          </pre>
        </details>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={onReset}
          className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Try again
        </button>
        <button
          onClick={() => {
            window.location.href = '/';
          }}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Go home
        </button>
      </div>
    </div>
  );
}
