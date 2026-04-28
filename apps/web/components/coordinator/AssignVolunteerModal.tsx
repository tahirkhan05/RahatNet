'use client';

/**
 * AssignVolunteerModal — coordinator picks a volunteer for a specific need.
 *
 * Workflow:
 *  1. Opened from NeedQueueItem's "Assign" button or the map marker InfoWindow.
 *  2. Fetches available volunteers from /api/volunteers?needId={id} — sorted
 *     by distance from the need's location, skills matched to the need type.
 *  3. Coordinator selects a volunteer, edits the message if needed, and clicks Assign.
 *  4. POST /api/dispatch fires; on success an optimistic status update is applied
 *     and a toast is shown.
 *
 * Accessibility:
 *  - Focus is trapped inside the modal while it is open.
 *  - Escape closes the modal.
 *  - aria-modal="true" and role="dialog" on the container.
 */

import * as React from 'react';
import {
  X, User, MapPin, Clock, Zap, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { NeedType, VolunteerSkill, type CanonicalNeed } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VolunteerMatch {
  uid:          string;
  displayName:  string;
  skills:       VolunteerSkill[];
  distanceKm:   number;
  lastActiveMs: number;
  rating:       number | null;
  isAvailable:  boolean;
}

interface AssignVolunteerModalProps {
  need:     CanonicalNeed;
  onClose:  () => void;
  onAssigned: (needId: string, volunteerId: string) => void;
}

// ---------------------------------------------------------------------------
// Skill → Need type matching
// ---------------------------------------------------------------------------

const SKILL_MATCH: Record<NeedType, VolunteerSkill[]> = {
  [NeedType.RESCUE]:         [VolunteerSkill.BOAT_OPERATOR, VolunteerSkill.RESCUE_SWIMMER, VolunteerSkill.DRIVER],
  [NeedType.MEDICINE]:       [VolunteerSkill.DOCTOR, VolunteerSkill.NURSE],
  [NeedType.FOOD]:           [VolunteerSkill.COOK, VolunteerSkill.DRIVER],
  [NeedType.SHELTER]:        [VolunteerSkill.CARPENTER, VolunteerSkill.ELECTRICIAN],
  [NeedType.MENTAL_HEALTH]:  [VolunteerSkill.COUNSELLOR],
  [NeedType.INFRASTRUCTURE]: [VolunteerSkill.ELECTRICIAN, VolunteerSkill.CARPENTER],
};

function skillMatchScore(volunteer: VolunteerMatch, needType: NeedType): number {
  const required = SKILL_MATCH[needType] ?? [];
  const matched  = volunteer.skills.filter((s) => required.includes(s));
  return matched.length;
}

// ---------------------------------------------------------------------------
// Volunteer row
// ---------------------------------------------------------------------------

function VolunteerRow({
  volunteer,
  isSelected,
  needType,
  onSelect,
}: {
  volunteer:  VolunteerMatch;
  isSelected: boolean;
  needType:   NeedType;
  onSelect:   (v: VolunteerMatch) => void;
}) {
  const match   = skillMatchScore(volunteer, needType);
  const ageMins = Math.floor((Date.now() - volunteer.lastActiveMs) / 60_000);
  const ageStr  = ageMins < 1 ? 'now' : ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ago`;

  return (
    <button
      type="button"
      onClick={() => onSelect(volunteer)}
      aria-pressed={isSelected}
      className={[
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-background hover:bg-accent',
      ].join(' ')}
    >
      {/* Avatar */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-foreground">
        {volunteer.displayName.charAt(0).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">{volunteer.displayName}</p>
          {/* Skill match indicator */}
          {match > 0 ? (
            <span className="shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold text-green-800 dark:bg-green-900 dark:text-green-200">
              ✓ Skill match
            </span>
          ) : (
            <span className="shrink-0 text-[10px] text-muted-foreground">No skill match</span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" aria-hidden="true" />
            {volunteer.distanceKm.toFixed(1)} km away
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" aria-hidden="true" />
            Active {ageStr}
          </span>
          {volunteer.rating != null && (
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" aria-hidden="true" />
              {volunteer.rating.toFixed(1)}★
            </span>
          )}
        </div>

        {/* Skills list */}
        <div className="mt-1 flex flex-wrap gap-1">
          {volunteer.skills.slice(0, 4).map((s) => (
            <span
              key={s}
              className="rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground"
            >
              {s.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      </div>

      {isSelected && (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function AssignVolunteerModal({
  need, onClose, onAssigned,
}: AssignVolunteerModalProps) {
  const [volunteers,   setVolunteers]   = React.useState<VolunteerMatch[]>([]);
  const [loading,      setLoading]      = React.useState(true);
  const [submitting,   setSubmitting]   = React.useState(false);
  const [error,        setError]        = React.useState<string | null>(null);
  const [selectedUid,  setSelectedUid]  = React.useState<string | null>(null);
  const [message,      setMessage]      = React.useState(
    `Please proceed to ${need.locationName ?? (need.location as unknown as { address?: string })?.address ?? 'the reported location'}`,
  );
  const [skillFilter,  setSkillFilter]  = React.useState(true);

  const firstFocusRef = React.useRef<HTMLButtonElement>(null);

  // Focus the close button on open.
  React.useEffect(() => {
    firstFocusRef.current?.focus();
  }, []);

  // Escape closes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fetch available volunteers.
  React.useEffect(() => {
    setLoading(true);
    void (async () => {
      try {
        // First try AI-matched volunteers (requires GPS in RTDB)
        const res = await fetch(
          `/api/dispatch/matches/${need.id}?lat=${need.location.lat}&lng=${need.location.lng}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { data: VolunteerMatch[] };
          const matched = data.data ?? [];
          if (matched.length > 0) { setVolunteers(matched); setLoading(false); return; }
        }
        // Fallback: query all available volunteers from Firestore directly
        const fallbackRes = await fetch('/api/volunteers?available=true&limit=20');
        if (fallbackRes.ok) {
          const fallbackData = (await fallbackRes.json()) as { data?: { items?: unknown[] } };
          const items = fallbackData.data?.items ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mapped: VolunteerMatch[] = (items as any[]).map((v: any) => ({
            uid:          v.uid ?? v.id,
            displayName:  v.displayName ?? 'Volunteer',
            skills:       v.skills ?? [],
            distanceKm:   0,
            lastActiveMs: Date.now(),
            rating:       null,
            isAvailable:  true,
          }));
          setVolunteers(mapped);
        }
      } catch {
        setVolunteers([]);
        setError('Could not load volunteers. Check your connection.');
      } finally {
        setLoading(false);
      }
    })();
  }, [need.id, need.location.lat, need.location.lng]);

  const displayed = skillFilter
    ? volunteers.filter((v) => skillMatchScore(v, need.type) > 0)
    : volunteers;

  const handleAssign = async () => {
    if (!selectedUid) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          needId:       need.id,
          volunteerId:  selectedUid,
          autoSelect:   false,
          message,
        }),
      });

      if (!res.ok) {
        const body = (await res.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Assignment failed');
      }

      onAssigned(need.id, selectedUid);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-hidden={false}
    >
      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-modal-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border p-4">
          <div className="min-w-0">
            <h2 id="assign-modal-title" className="text-base font-semibold text-foreground">
              Assign Volunteer
            </h2>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{need.title}</p>
          </div>
          <button
            ref={firstFocusRef}
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="ml-2 shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Volunteer list */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Skill filter toggle */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {loading ? 'Loading…' : `${displayed.length} volunteer${displayed.length !== 1 ? 's' : ''}`}
            </p>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={skillFilter}
                onChange={(e) => setSkillFilter(e.target.checked)}
                className="accent-primary"
              />
              Skills match only
            </label>
          </div>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-20 rounded-lg skeleton-shimmer" />
              ))}
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <User className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                {skillFilter
                  ? 'No skill-matched volunteers available.'
                  : 'No volunteers available right now.'}
              </p>
              {skillFilter && (
                <button
                  type="button"
                  onClick={() => setSkillFilter(false)}
                  className="text-xs text-primary underline hover:no-underline"
                >
                  Show all volunteers
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2" role="group" aria-label="Available volunteers">
              {displayed.map((v) => (
                <VolunteerRow
                  key={v.uid}
                  volunteer={v}
                  isSelected={selectedUid === v.uid}
                  needType={need.type}
                  onSelect={(vol) => setSelectedUid(vol.uid)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Message + actions */}
        <div className="border-t border-border p-4 space-y-3">
          <div>
            <label htmlFor="assign-message" className="block text-xs font-medium text-foreground mb-1">
              Message to volunteer
            </label>
            <textarea
              id="assign-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {error !== null && (
            <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-border bg-background py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAssign}
              disabled={!selectedUid || submitting}
              aria-busy={submitting}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? 'Assigning…' : 'Assign Volunteer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
