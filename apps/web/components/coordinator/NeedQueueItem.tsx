'use client';

/**
 * NeedQueueItem — single row in the war-room priority queue.
 *
 * Memoized with React.memo — only re-renders when its own need changes or
 * when the selected need ID changes (for the selection ring highlight).
 *
 * Accessible: the entire card is keyboard-focusable with Enter/Space to
 * select, A to assign, and D to mark as duplicate.
 */

import * as React from 'react';
import {
  Anchor, UtensilsCrossed, Cross, Home, Heart, Building2,
  AlertTriangle, Clock, Users, ShieldAlert, MapPin, Copy,
} from 'lucide-react';
import {
  NeedType, NeedStatus, NeedSeverity,
  type CanonicalNeed,
} from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NeedQueueItemProps {
  need:        CanonicalNeed;
  isSelected:  boolean;
  onSelect:    (need: CanonicalNeed) => void;
  onAssign:    (need: CanonicalNeed) => void;
  onDuplicate: (need: CanonicalNeed) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NEED_ICONS: Record<NeedType, React.ReactNode> = {
  [NeedType.RESCUE]:         <Anchor        className="h-4 w-4" aria-hidden="true" />,
  [NeedType.FOOD]:           <UtensilsCrossed className="h-4 w-4" aria-hidden="true" />,
  [NeedType.MEDICINE]:       <Cross         className="h-4 w-4" aria-hidden="true" />,
  [NeedType.SHELTER]:        <Home          className="h-4 w-4" aria-hidden="true" />,
  [NeedType.MENTAL_HEALTH]:  <Heart         className="h-4 w-4" aria-hidden="true" />,
  [NeedType.INFRASTRUCTURE]: <Building2     className="h-4 w-4" aria-hidden="true" />,
};

const SEVERITY_CONFIG: Record<NeedSeverity, { label: string; badge: string; border: string }> = {
  [NeedSeverity.CRITICAL]: {
    label:  'Critical',
    badge:  'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    border: 'border-l-red-500',
  },
  [NeedSeverity.URGENT]: {
    label:  'Urgent',
    badge:  'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    border: 'border-l-amber-500',
  },
  [NeedSeverity.NORMAL]: {
    label:  'Normal',
    badge:  'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    border: 'border-l-blue-500',
  },
  [NeedSeverity.LOW]: {
    label:  'Low',
    badge:  'bg-secondary text-muted-foreground',
    border: 'border-l-muted',
  },
};

const STATUS_LABELS: Partial<Record<NeedStatus, string>> = {
  [NeedStatus.VERIFIED]:    'Unassigned',
  [NeedStatus.ASSIGNED]:    'Assigned',
  [NeedStatus.IN_PROGRESS]: 'In Progress',
  [NeedStatus.RESOLVED]:    'Resolved',
};

function relativeTime(ts: { seconds: number } | null | undefined): string {
  if (ts == null) return '';
  const diffMs   = Date.now() - ts.seconds * 1000;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1)  return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs  < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component (memoized)
// ---------------------------------------------------------------------------

function NeedQueueItemInner({
  need, isSelected, onSelect, onAssign, onDuplicate,
}: NeedQueueItemProps) {
  const sev    = SEVERITY_CONFIG[need.severity] ?? SEVERITY_CONFIG[NeedSeverity.NORMAL];
  const canAssign =
    need.status === NeedStatus.VERIFIED ||
    need.status === NeedStatus.PENDING  ||
    need.status === NeedStatus.AI_PROCESSING;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(need);
    }
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      e.stopPropagation();
      if (canAssign) onAssign(need);
    }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      e.stopPropagation();
      onDuplicate(need);
    }
  };

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => onSelect(need)}
      className={[
        'group relative cursor-pointer rounded-lg border border-l-4 bg-card p-3 transition-all',
        'hover:border-primary/30 hover:shadow-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        sev.border,
        isSelected ? 'ring-2 ring-primary ring-offset-1' : '',
      ].join(' ')}
    >
      {/* Row 1: severity badge + type icon + title */}
      <div className="flex items-start gap-2">
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${sev.badge}`}>
          {NEED_ICONS[need.type]}
          {sev.label}
        </span>
        <p className="flex-1 truncate text-sm font-medium text-foreground">
          {need.title}
        </p>
      </div>

      {/* Row 2: location */}
      <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{need.locationName}</span>
      </div>

      {/* Row 3: people + vulnerable + time */}
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" aria-hidden="true" />
          {need.affectedCount}
        </span>
        {need.hasVulnerable && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            Vulnerable
          </span>
        )}
        <span className="flex items-center gap-1 ml-auto">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {relativeTime(need.createdAt as unknown as { seconds: number })}
        </span>
      </div>

      {/* Row 4: status + actions (shown on hover/focus or when selected) */}
      <div className={[
        'mt-2 flex items-center gap-2 transition-opacity',
        isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
      ].join(' ')}>
        <span className="text-xs text-muted-foreground">
          {STATUS_LABELS[need.status] ?? need.status}
        </span>

        <div className="ml-auto flex gap-1.5">
          {canAssign && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAssign(need); }}
              aria-label={`Assign volunteer to: ${need.title}`}
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Assign
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDuplicate(need); }}
            aria-label={`Mark as duplicate: ${need.title}`}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Urgency score pip */}
      <div
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-muted-foreground"
        title={`Urgency score: ${need.urgencyScore}`}
        aria-label={`Urgency ${need.urgencyScore}`}
      >
        {need.urgencyScore}
      </div>
    </div>
  );
}

export const NeedQueueItem = React.memo(NeedQueueItemInner);
NeedQueueItem.displayName = 'NeedQueueItem';
