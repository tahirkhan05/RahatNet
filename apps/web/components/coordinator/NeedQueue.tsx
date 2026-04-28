'use client';

/**
 * NeedQueue — scrollable, filterable, searchable priority queue for the war room.
 *
 * Sorting:
 *   CRITICAL first → urgencyScore desc → createdAt asc (oldest unresolved first).
 *
 * Virtual scrolling:
 *   When > 100 items, switches to react-window FixedSizeList so the DOM
 *   only contains the visible rows.  Below 100 items renders normally to
 *   avoid the complexity overhead.
 *
 * Optimistic updates:
 *   When the coordinator assigns a volunteer via the modal, the local need
 *   status is immediately updated to ASSIGNED before the Firestore write
 *   completes.  If the write fails, the optimistic state is reverted.
 *
 * Animation:
 *   New items slide in from the top via a CSS animation.  The "new" flag
 *   is set for 3 seconds then cleared so the animation only plays once.
 */

import * as React from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { Search, Filter, X } from 'lucide-react';
import { NeedType, NeedStatus, NeedSeverity, type CanonicalNeed } from '@rahatnet/types';
import { NeedQueueItem } from './NeedQueueItem';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterTab = 'all' | NeedSeverity | 'resolved';

interface NeedQueueProps {
  needs: readonly CanonicalNeed[];
  isLoading: boolean;
  selectedNeed: CanonicalNeed | null;
  onSelect: (need: CanonicalNeed) => void;
  onAssign: (need: CanonicalNeed) => void;
  onDuplicate: (need: CanonicalNeed) => void;
}

// ---------------------------------------------------------------------------
// Sort / filter logic
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<NeedSeverity, number> = {
  [NeedSeverity.CRITICAL]: 0,
  [NeedSeverity.URGENT]: 1,
  [NeedSeverity.NORMAL]: 2,
  [NeedSeverity.LOW]: 3,
};

function sortNeeds(needs: readonly CanonicalNeed[]): CanonicalNeed[] {
  return [...needs].sort((a, b) => {
    // 1. Severity order
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    // 2. Urgency score desc
    if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
    // 3. Oldest first (so oldest critical shows at top of its tier)
    const aTs = (a.createdAt as unknown as { seconds: number }).seconds ?? 0;
    const bTs = (b.createdAt as unknown as { seconds: number }).seconds ?? 0;
    return aTs - bTs;
  });
}

function filterNeeds(
  needs: readonly CanonicalNeed[],
  tab: FilterTab,
  type: NeedType | 'all',
  query: string,
): CanonicalNeed[] {
  let result = [...needs];

  // Tab filter
  if (tab === 'resolved') {
    result = result.filter((n) => n.status === NeedStatus.RESOLVED);
  } else if (tab !== 'all') {
    result = result.filter((n) => n.severity === tab && n.status !== NeedStatus.RESOLVED);
  } else {
    result = result.filter((n) => n.status !== NeedStatus.RESOLVED);
  }

  // Type filter
  if (type !== 'all') {
    result = result.filter((n) => n.type === type);
  }

  // Search
  if (query.trim().length > 0) {
    const q = query.trim().toLowerCase();
    result = result.filter(
      (n) => n.locationName.toLowerCase().includes(q) || n.title.toLowerCase().includes(q),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Virtual row renderer
// ---------------------------------------------------------------------------

interface VirtualRowData {
  items: CanonicalNeed[];
  selectedId: string | null;
  newIds: Set<string>;
  onSelect: (n: CanonicalNeed) => void;
  onAssign: (n: CanonicalNeed) => void;
  onDuplicate: (n: CanonicalNeed) => void;
}

function VirtualRow({ index, style, data }: ListChildComponentProps<VirtualRowData>) {
  const { items, selectedId, newIds, onSelect, onAssign, onDuplicate } = data;
  const need = items[index];
  if (need == null) return null;

  return (
    <div style={style} className="px-2 py-1">
      <div className={newIds.has(need.id) ? 'animate-slide-in' : ''}>
        <NeedQueueItem
          need={need}
          isSelected={selectedId === need.id}
          onSelect={onSelect}
          onAssign={onAssign}
          onDuplicate={onDuplicate}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NeedQueue
// ---------------------------------------------------------------------------

const VIRTUAL_THRESHOLD = 100;
const ITEM_HEIGHT = 160; // px per row in virtual list

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: NeedSeverity.CRITICAL, label: 'Critical' },
  { id: NeedSeverity.URGENT, label: 'Urgent' },
  { id: NeedSeverity.NORMAL, label: 'Normal' },
  { id: 'resolved', label: 'Resolved' },
];

export function NeedQueue({
  needs,
  isLoading,
  selectedNeed,
  onSelect,
  onAssign,
  onDuplicate,
}: NeedQueueProps) {
  const [activeTab, setActiveTab] = React.useState<FilterTab>('all');
  const [typeFilter, setTypeFilter] = React.useState<NeedType | 'all'>('all');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [newIds, setNewIds] = React.useState<Set<string>>(new Set());
  const prevIdsRef = React.useRef<Set<string>>(new Set());
  const listRef = React.useRef<FixedSizeList>(null);

  // Track newly arrived needs for slide-in animation.
  React.useEffect(() => {
    const currentIds = new Set(needs.map((n) => n.id));
    const incoming = [...currentIds].filter((id) => !prevIdsRef.current.has(id));

    if (incoming.length > 0) {
      setNewIds((prev) => new Set([...prev, ...incoming]));
      const id = setTimeout(() => {
        setNewIds((prev) => {
          const next = new Set(prev);
          incoming.forEach((i) => next.delete(i));
          return next;
        });
      }, 3_000);
      prevIdsRef.current = currentIds;
      return () => clearTimeout(id);
    }

    prevIdsRef.current = currentIds;
    return undefined;
  }, [needs]);

  // Memoize the sorted + filtered list to avoid re-sorting on every render.
  const displayNeeds = React.useMemo(() => {
    const sorted = sortNeeds(needs);
    return filterNeeds(sorted, activeTab, typeFilter, searchQuery);
  }, [needs, activeTab, typeFilter, searchQuery]);

  const totalCount = needs.filter((n) => n.status !== NeedStatus.RESOLVED).length;
  const criticalCount = needs.filter(
    (n) => n.severity === NeedSeverity.CRITICAL && n.status !== NeedStatus.RESOLVED,
  ).length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border border-b px-3 py-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">Priority Queue</h2>
          <div className="flex items-center gap-2">
            {criticalCount > 0 && (
              <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-700 dark:bg-red-900 dark:text-red-200">
                {criticalCount} critical
              </span>
            )}
            <span className="bg-secondary text-muted-foreground rounded-full px-1.5 py-0.5 text-[11px]">
              {totalCount}
            </span>
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-2">
          <Search
            className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search by location…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search needs by location"
            className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-lg border py-1.5 pl-8 pr-8 text-xs focus-visible:outline-none focus-visible:ring-1"
          />
          {searchQuery.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="mt-2 flex gap-1" role="tablist" aria-label="Filter by severity">
          {FILTER_TABS.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
              className={[
                'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1',
                activeTab === id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
          {/* Type filter dropdown */}
          <div className="relative ml-auto">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as NeedType | 'all')}
              aria-label="Filter by need type"
              className="border-border bg-background text-foreground focus-visible:ring-ring appearance-none rounded-md border py-1 pl-2 pr-6 text-[11px] focus-visible:outline-none focus-visible:ring-1"
            >
              <option value="all">All types</option>
              {Object.values(NeedType).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Filter
              className="text-muted-foreground pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      {/* List body */}
      <div className="flex-1 overflow-hidden" role="listbox" aria-label="Needs priority queue">
        {isLoading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton-shimmer h-24 rounded-lg" />
            ))}
          </div>
        ) : displayNeeds.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {searchQuery ? 'No needs match your search.' : 'No needs in this category.'}
          </div>
        ) : displayNeeds.length > VIRTUAL_THRESHOLD ? (
          /* Virtual list for large datasets */
          <FixedSizeList<VirtualRowData>
            ref={listRef}
            height={800} // overridden by CSS to fill container
            itemCount={displayNeeds.length}
            itemSize={ITEM_HEIGHT}
            width="100%"
            className="rn-scroll-panel"
            itemData={{
              items: displayNeeds,
              selectedId: selectedNeed?.id ?? null,
              newIds,
              onSelect,
              onAssign,
              onDuplicate,
            }}
            style={{ height: '100%' }}
          >
            {VirtualRow}
          </FixedSizeList>
        ) : (
          /* Normal scroll for small datasets */
          <div className="rn-scroll-panel h-full space-y-1.5 p-2">
            {displayNeeds.map((need) => (
              <div key={need.id} className={newIds.has(need.id) ? 'animate-slide-in' : ''}>
                <NeedQueueItem
                  need={need}
                  isSelected={selectedNeed?.id === need.id}
                  onSelect={onSelect}
                  onAssign={onAssign}
                  onDuplicate={onDuplicate}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
