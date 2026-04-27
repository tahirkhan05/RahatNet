import { create } from 'zustand';
import type { DisasterEvent } from '@rahatnet/types';

interface DisasterState {
  activeDisaster: DisasterEvent | null;
  disasters: DisasterEvent[];
  setActiveDisaster: (disaster: DisasterEvent | null) => void;
  setDisasters: (disasters: DisasterEvent[]) => void;
}

export const useDisasterStore = create<DisasterState>()((set) => ({
  activeDisaster: null,
  disasters: [],

  setActiveDisaster: (activeDisaster) => set({ activeDisaster }),
  setDisasters: (disasters) => set({ disasters }),
}));
