import { create } from 'zustand';
import type { CanonicalNeed, NeedSeverity } from '@rahatnet/types';
import { NeedStatus } from '@rahatnet/types';

interface NeedsFilter {
  severity: NeedSeverity | 'ALL';
  status: NeedStatus | 'ALL';
  search: string;
}

interface NeedsState {
  needs: CanonicalNeed[];
  selectedNeedId: string | null;
  filter: NeedsFilter;
  setNeeds: (needs: CanonicalNeed[]) => void;
  upsertNeed: (need: CanonicalNeed) => void;
  selectNeed: (id: string | null) => void;
  setFilter: (filter: Partial<NeedsFilter>) => void;
}

export const useNeedsStore = create<NeedsState>()((set) => ({
  needs: [],
  selectedNeedId: null,
  filter: {
    severity: 'ALL',
    status: 'ALL',
    search: '',
  },

  setNeeds: (needs) => set({ needs }),

  upsertNeed: (need) =>
    set((state) => {
      const idx = state.needs.findIndex((n) => n.id === need.id);
      if (idx >= 0) {
        const updated = [...state.needs];
        updated[idx] = need;
        return { needs: updated };
      }
      return { needs: [need, ...state.needs] };
    }),

  selectNeed: (selectedNeedId) => set({ selectedNeedId }),

  setFilter: (filter) =>
    set((state) => ({ filter: { ...state.filter, ...filter } })),
}));
