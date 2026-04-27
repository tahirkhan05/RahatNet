'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingSpinnerProps {
  /** Size in pixels (maps to Tailwind h-/w- classes). Default 24. */
  size?:    number;
  /** Optional accessible label. */
  label?:   string;
  className?: string;
}

export function LoadingSpinner({
  size    = 24,
  label   = 'Loading…',
  className = '',
}: LoadingSpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center justify-center ${className}`}
    >
      <Loader2
        className="animate-spin text-primary"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Full-screen centred spinner — used for page-level loading states. */
export function PageSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <LoadingSpinner size={40} label={label} />
    </div>
  );
}
