import type { VolunteerMatch } from '@/lib/ai/dispatch';

export const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingCandidates = new Map<string, VolunteerMatch[]>();

export function cancelAutoReassign(assignmentId: string): void {
  const timerId = pendingTimers.get(assignmentId);
  if (timerId !== undefined) {
    clearTimeout(timerId);
    pendingTimers.delete(assignmentId);
    pendingCandidates.delete(assignmentId);
  }
}
