import { create } from 'zustand';
import { AssignmentStatus } from '@rahatnet/types';
import type { CanonicalNeed } from '@rahatnet/types';

interface ActiveTask {
  assignmentId: string;
  need:         CanonicalNeed;
  acceptedAt:   number;
}

interface VolunteerState {
  isAvailable:        boolean;
  activeTask:         ActiveTask | null;
  currentLat:         number | null;
  currentLng:         number | null;

  setAvailability:    (available: boolean) => void;
  setActiveTask:      (task: ActiveTask | null) => void;
  setLocation:        (lat: number, lng: number) => void;
  clearTask:          () => void;
}

export const useVolunteerStore = create<VolunteerState>()((set) => ({
  isAvailable:  false,
  activeTask:   null,
  currentLat:   null,
  currentLng:   null,

  setAvailability: (available) => set({ isAvailable: available }),

  setActiveTask: (task) => set({ activeTask: task }),

  setLocation: (lat, lng) => set({ currentLat: lat, currentLng: lng }),

  clearTask: () => set({ activeTask: null }),
}));
