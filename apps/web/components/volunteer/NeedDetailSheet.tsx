'use client';

/**
 * NeedDetailSheet — full-screen bottom sheet showing complete need details
 * before a volunteer commits to helping.
 *
 * Shows everything: description, location, affected people, vulnerability
 * flags, report count, urgency score, and time reported.
 * The "I can help" confirmation is at the bottom of this sheet.
 */

import * as React from 'react';
import {
  X,
  MapPin,
  Users,
  Clock,
  ShieldAlert,
  AlertTriangle,
  ThumbsUp,
  Loader2,
  Navigation,
  Play,
  Pause,
  Mic,
  Anchor,
  UtensilsCrossed,
  Cross,
  Home,
  Heart,
  Building2,
} from 'lucide-react';
import { NeedType, NeedSeverity, type CanonicalNeed } from '@rahatnet/types';

const NEED_LABELS: Record<NeedType, string> = {
  RESCUE: 'Rescue / Evacuation',
  FOOD: 'Food / Water',
  MEDICINE: 'Medicine / Medical',
  SHELTER: 'Shelter',
  MENTAL_HEALTH: 'Mental Health Support',
  INFRASTRUCTURE: 'Infrastructure',
};

const NEED_ICONS: Record<NeedType, React.ReactNode> = {
  RESCUE: <Anchor className="h-6 w-6" />,
  FOOD: <UtensilsCrossed className="h-6 w-6" />,
  MEDICINE: <Cross className="h-6 w-6" />,
  SHELTER: <Home className="h-6 w-6" />,
  MENTAL_HEALTH: <Heart className="h-6 w-6" />,
  INFRASTRUCTURE: <Building2 className="h-6 w-6" />,
};

const SEVERITY_COLORS: Record<NeedSeverity, string> = {
  CRITICAL: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  URGENT: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  NORMAL: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  LOW: 'bg-secondary text-muted-foreground',
};

function relativeTime(ts: { seconds: number } | null | undefined): string {
  if (ts == null) return '';
  const diff = Math.floor((Date.now() - ts.seconds * 1000) / 60_000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  const hrs = Math.floor(diff / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function VoiceNotePlayer({ url }: { url: string }) {
  const [playing, setPlaying] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
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
      className="border-border bg-card text-foreground hover:bg-accent flex w-full items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium"
    >
      <Mic className="text-primary h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Voice note from reporter</span>
      {playing ? (
        <Pause className="text-primary h-4 w-4 shrink-0" />
      ) : (
        <Play className="text-primary h-4 w-4 shrink-0" />
      )}
    </button>
  );
}

interface NeedDetailSheetProps {
  need: CanonicalNeed;
  distanceM?: number;
  onClose: () => void;
  onConfirm: (need: CanonicalNeed) => Promise<void>;
}

export function NeedDetailSheet({ need, distanceM, onClose, onConfirm }: NeedDetailSheetProps) {
  const [confirming, setConfirming] = React.useState(false);
  const [voiceNoteUrl, setVoiceNoteUrl] = React.useState<string | null>(null);

  // Fetch voice note URL from the first source raw report
  React.useEffect(() => {
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
  }, [need.sourceReportIds]);

  const handleConfirm = async () => {
    setConfirming(true);
    await onConfirm(need);
    setConfirming(false);
    onClose();
  };

  const formatDistance = (m: number) =>
    m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;

  const createdAt = need.createdAt as unknown as { seconds: number } | null;
  const severityColor = SEVERITY_COLORS[need.severity] ?? SEVERITY_COLORS.NORMAL;
  const typeIcon = need.type ? NEED_ICONS[need.type] : <MapPin className="h-6 w-6" />;
  const typeLabel = need.type ? NEED_LABELS[need.type] : 'Need';
  const locationDisplay =
    need.locationName?.trim() ||
    (need.location?.lat
      ? `${need.location.lat.toFixed(4)}, ${need.location.lng.toFixed(4)}`
      : 'Location unknown');

  // Prevent background scroll
  React.useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Need details"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Sheet */}
      <div className="border-border bg-background relative flex max-h-[90vh] flex-col rounded-t-2xl border-t shadow-2xl">
        {/* Handle + close */}
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div className="bg-border absolute left-1/2 top-2 mx-auto h-1 w-10 -translate-x-1/2 rounded-full" />
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary text-muted-foreground hover:text-foreground ml-auto flex h-8 w-8 items-center justify-center rounded-full"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div
              className="bg-primary/10 text-primary flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
              aria-hidden="true"
            >
              {typeIcon}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground text-xl font-bold">{typeLabel}</h2>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${severityColor}`}
                >
                  {need.severity}
                </span>
                {need.hasVulnerable && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    <ShieldAlert className="h-3 w-3" />
                    Vulnerable
                  </span>
                )}
                {need.reportCount > 1 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                    <AlertTriangle className="h-3 w-3" />
                    {need.reportCount} reports
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Location + distance */}
          <div className="border-border bg-card space-y-2 rounded-xl border px-4 py-3">
            <div className="flex items-start gap-2">
              <MapPin className="text-primary mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-foreground text-sm font-medium">{locationDisplay}</p>
            </div>
            {distanceM !== undefined && (
              <div className="flex items-center gap-2">
                <Navigation className="text-muted-foreground h-4 w-4 shrink-0" />
                <p className="text-muted-foreground text-sm">
                  <span className="text-foreground font-semibold">{formatDistance(distanceM)}</span>{' '}
                  from your location
                </p>
              </div>
            )}
          </div>

          {/* Description */}
          {need.description && need.description.trim().length > 0 && (
            <div className="border-border bg-card rounded-xl border px-4 py-3">
              <p className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wider">
                What was reported
              </p>
              <p className="text-foreground text-sm leading-relaxed">{need.description}</p>
            </div>
          )}

          {/* Voice note */}
          {voiceNoteUrl && <VoiceNotePlayer url={voiceNoteUrl} />}

          {/* Key facts */}
          <div className="border-border bg-card divide-border divide-y rounded-xl border">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                <Users className="h-4 w-4" /> People affected
              </span>
              <span className="text-foreground text-sm font-semibold">
                {need.affectedCount} {need.affectedCount === 1 ? 'person' : 'people'}
              </span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4" /> Reported
              </span>
              <span className="text-foreground text-sm font-semibold">
                {relativeTime(createdAt)}
              </span>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-muted-foreground text-sm">Urgency score</span>
              <span className="text-foreground text-sm font-semibold">
                {need.urgencyScore} / 10
              </span>
            </div>
          </div>

          {/* Vulnerable note */}
          {need.hasVulnerable && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                This household includes a vulnerable individual — elderly, child, disabled,
                pregnant, or critically ill. Prioritise accordingly.
              </p>
            </div>
          )}
        </div>

        {/* Sticky confirm footer */}
        <div className="border-border bg-background space-y-2 border-t px-4 pb-8 pt-3">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming}
            aria-busy={confirming}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 active:scale-[0.98] disabled:opacity-60"
          >
            {confirming ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> Registering interest…
              </>
            ) : (
              <>
                <ThumbsUp className="h-5 w-5" /> Yes, I can help
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="border-border bg-background text-muted-foreground hover:bg-accent flex min-h-[44px] w-full items-center justify-center rounded-xl border text-sm font-medium"
          >
            Not this one
          </button>
        </div>
      </div>
    </div>
  );
}
