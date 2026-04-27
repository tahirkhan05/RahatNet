import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile } from '@rahatnet/types';
import { UserRole } from '@rahatnet/types';

interface AuthState {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  setUser: (user: UserProfile | null) => void;
  setLoading: (loading: boolean) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: true,
      isAuthenticated: false,

      setUser: (user) =>
        set({
          user,
          isAuthenticated: user !== null,
          isLoading: false,
        }),

      setLoading: (isLoading) => set({ isLoading }),

      clearAuth: () =>
        set({
          user: null,
          isAuthenticated: false,
          isLoading: false,
        }),
    }),
    {
      name: 'rahatnet-auth',
      partialize: (state) => ({ user: state.user }),
    },
  ),
);

export function selectRole(state: AuthState): UserRole {
  return state.user?.role ?? UserRole.CITIZEN;
}
