'use client';

import * as React from 'react';
import { useWarRoom } from '@/hooks/useWarRoom';
import { NeedQueue } from '@/components/coordinator/NeedQueue';
import { AssignVolunteerModal } from '@/components/coordinator/AssignVolunteerModal';
import type { CanonicalNeed } from '@rahatnet/types';

const DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'active-disaster-001';

export default function NeedsPage() {
  const { needs, isLoading } = useWarRoom(DISASTER_ID);
  const [selectedNeed, setSelectedNeed] = React.useState<CanonicalNeed | null>(null);
  const [assignNeed, setAssignNeed] = React.useState<CanonicalNeed | null>(null);

  return (
    <div className="space-y-4">
      <NeedQueue
        needs={needs}
        isLoading={isLoading}
        selectedNeed={selectedNeed}
        onSelect={setSelectedNeed}
        onAssign={setAssignNeed}
        onDuplicate={() => {}}
      />
      {assignNeed && (
        <AssignVolunteerModal
          need={assignNeed}
          onClose={() => setAssignNeed(null)}
          onAssigned={() => setAssignNeed(null)}
        />
      )}
    </div>
  );
}
