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
  Anchor,
  UtensilsCrossed,
  Cross,
  Home,
  Heart,
  Building2,
  AlertTriangle,
  Clock,
  Users,
  ShieldAlert,
  MapPin,
  Copy,
  Mic,
  Play,
  Pause,
  ClipboardList,
} from 'lucide-react';
import { NeedType, NeedStatus, NeedSeverity, type CanonicalNeed } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NeedQueueItemProps {
  need: CanonicalNeed;
  isSelected: boolean;
  onSelect: (need: CanonicalNeed) => void;
  onAssign: (need: CanonicalNeed) => void;
  onDuplicate: (need: CanonicalNeed) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NEED_ICONS: Record<NeedType, React.ReactNode> = {
  [NeedType.RESCUE]: <Anchor className="h-4 w-4" aria-hidden="true" />,
  [NeedType.FOOD]: <UtensilsCrossed className="h-4 w-4" aria-hidden="true" />,
  [NeedType.MEDICINE]: <Cross className="h-4 w-4" aria-hidden="true" />,
  [NeedType.SHELTER]: <Home className="h-4 w-4" aria-hidden="true" />,
  [NeedType.MENTAL_HEALTH]: <Heart className="h-4 w-4" aria-hidden="true" />,
  [NeedType.INFRASTRUCTURE]: <Building2 className="h-4 w-4" aria-hidden="true" />,
};

const SEVERITY_CONFIG: Record<NeedSeverity, { label: string; badge: string; border: string }> = {
  [NeedSeverity.CRITICAL]: {
    label: 'Critical',
    badge: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    border: 'border-l-red-500',
  },
  [NeedSeverity.URGENT]: {
    label: 'Urgent',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    border: 'border-l-amber-500',
  },
  [NeedSeverity.NORMAL]: {
    label: 'Normal',
    badge: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    border: 'border-l-blue-500',
  },
  [NeedSeverity.LOW]: {
    label: 'Low',
    badge: 'bg-secondary text-muted-foreground',
    border: 'border-l-muted',
  },
};

const STATUS_LABELS: Partial<Record<NeedStatus, string>> = {
  [NeedStatus.VERIFIED]: 'Unassigned',
  [NeedStatus.ASSIGNED]: 'Assigned',
  [NeedStatus.IN_PROGRESS]: 'In Progress',
  [NeedStatus.RESOLVED]: 'Resolved',
};

function relativeTime(ts: { seconds: number } | null | undefined): string {
  if (ts == null) return '';
  const diffMs = Date.now() - ts.seconds * 1000;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component (memoized)
// ---------------------------------------------------------------------------

function VoiceNotePlayer({ url }: { url: string }) {
  const [playing, setPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      void audioRef.current.play();
      setPlaying(true);
    }
  };
  React.useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={toggle}
      className="border-border bg-background text-foreground hover:bg-accent focus-visible:ring-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1"
    >
      <Mic className="text-primary h-3 w-3 shrink-0" />
      Voice note
      {playing ? (
        <Pause className="text-primary h-3 w-3" />
      ) : (
        <Play className="text-primary h-3 w-3" />
      )}
    </button>
  );
}

function NeedQueueItemInner({
  need,
  isSelected,
  onSelect,
  onAssign,
  onDuplicate,
}: NeedQueueItemProps) {
  const sev = SEVERITY_CONFIG[need.severity] ?? SEVERITY_CONFIG[NeedSeverity.NORMAL];
  const [voiceNoteUrl, setVoiceNoteUrl] = React.useState<string | null>(null);

  // Fetch voice note when selected
  React.useEffect(() => {
    if (!isSelected) return;
    const firstId = need.sourceReportIds?.[0];
    if (!firstId) return;
    void (async () => {
      try {
        const { getFirestore, doc, getDoc } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const snap = await getDoc(doc(getFirestore(firebaseApp), 'rawReports', firstId));
        if (snap.exists()) {
          const url = snap.data()['voiceNoteUrl'] as string | null;
          if (url && !url.startsWith('data:')) setVoiceNoteUrl(url);
        }
      } catch {
        /* non-fatal */
      }
    })();
  }, [isSelected, need.sourceReportIds]);
  const canAssign =
    need.status === NeedStatus.VERIFIED ||
    need.status === NeedStatus.PENDING ||
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

  const isSurvey = (need as CanonicalNeed & { source?: string }).source === 'SURVEY';
  const descSnippet = need.description?.trim().slice(0, 90);

  // Fall back to coordinates if locationName is empty
  const locationDisplay =
    need.locationName?.trim() ||
    (need.location?.lat && need.location?.lng
      ? `${need.location.lat.toFixed(4)}, ${need.location.lng.toFixed(4)}`
      : null);

  // Detect generic AI-generated titles so we can de-emphasise them
  const isGenericTitle =
    !need.title ||
    /^(rescue|food|medicine|shelter|mental_?health|infrastructure) need reported/i.test(
      need.title,
    ) ||
    /need at unknown/i.test(need.title);

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => onSelect(need)}
      className={[
        'bg-card group relative cursor-pointer rounded-lg border border-l-4 p-3 transition-all',
        'hover:border-primary/30 hover:shadow-sm',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        sev.border,
        isSelected ? 'ring-primary ring-2 ring-offset-1' : '',
      ].join(' ')}
    >
      {/* Row 1: severity badge + survey tag + time */}
      <div className="flex items-center gap-1.5 pr-7">
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${sev.badge}`}
        >
          {NEED_ICONS[need.type]}
          {sev.label}
        </span>
        {isSurvey && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
            <ClipboardList className="h-2.5 w-2.5" aria-hidden="true" />
            Survey
          </span>
        )}
        <span className="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]">
          <Clock className="h-2.5 w-2.5" aria-hidden="true" />
          {relativeTime(need.createdAt as unknown as { seconds: number })}
        </span>
      </div>

      {/* Row 2: title (skip if generic) + location */}
      {!isGenericTitle && (
        <p className="text-foreground mt-1.5 truncate text-xs font-semibold">{need.title}</p>
      )}
      <div
        className={`${isGenericTitle ? 'mt-1.5' : 'mt-0.5'} text-foreground flex items-center gap-1 text-xs font-medium`}
      >
        <MapPin className="text-muted-foreground h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{locationDisplay ?? 'Location pending…'}</span>
      </div>

      {/* Row 3: description snippet — primary identity when title is generic */}
      {descSnippet && descSnippet.length > 0 && (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px] leading-relaxed">
          {descSnippet}
          {(need.description?.length ?? 0) > 90 ? '…' : ''}
        </p>
      )}

      {/* Row 4: people + vulnerable + report count + status */}
      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="flex items-center gap-0.5">
          <Users className="h-3 w-3" aria-hidden="true" />
          {need.affectedCount} {need.affectedCount === 1 ? 'person' : 'people'}
        </span>
        {need.hasVulnerable && (
          <span className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            Vulnerable
          </span>
        )}
        {need.reportCount > 1 && (
          <span className="flex items-center gap-0.5 text-blue-600 dark:text-blue-400">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {need.reportCount} reports
          </span>
        )}
        <span
          className={[
            'ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            need.status === NeedStatus.ASSIGNED
              ? 'bg-primary/10 text-primary'
              : need.status === NeedStatus.IN_PROGRESS
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : need.status === NeedStatus.RESOLVED
                  ? 'bg-secondary text-muted-foreground'
                  : 'bg-secondary text-muted-foreground',
          ].join(' ')}
        >
          {STATUS_LABELS[need.status] ?? need.status}
        </span>
      </div>

      {/* Row 5: actions (always visible, not hidden) */}
      <div className="mt-2 flex items-center gap-1.5">
        {canAssign && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAssign(need);
            }}
            aria-label={`Assign volunteer to: ${need.title}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1"
          >
            Assign
          </button>
        )}
        {need.status === NeedStatus.ASSIGNED && (
          <span className="text-primary text-[11px]">● En route</span>
        )}
        {need.status === NeedStatus.IN_PROGRESS && (
          <span className="text-[11px] text-green-600 dark:text-green-400">● On site</span>
        )}
        {isSelected && voiceNoteUrl && <VoiceNotePlayer url={voiceNoteUrl} />}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(need);
          }}
          aria-label={`Mark as duplicate: ${need.title}`}
          className="border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring ml-auto rounded-md border px-2 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1"
        >
          <Copy className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {/* Urgency score pip */}
      <div
        className="bg-secondary text-muted-foreground absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
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
