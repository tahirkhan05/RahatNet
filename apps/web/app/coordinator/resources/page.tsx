'use client';

import { ResourceTracker } from '@/components/coordinator/ResourceTracker';

const DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'active-disaster-001';

export default function ResourcesPage() {
  return <ResourceTracker disasterEventId={DISASTER_ID} disasterName="Active Disaster" />;
}
