/**
 * /coordinator/war-room — server component shell.
 *
 * The disaster event ID comes from the environment variable
 * NEXT_PUBLIC_ACTIVE_DISASTER_ID (set per deployment / per disaster).
 * For demo purposes it falls back to 'demo-disaster-001'.
 *
 * Middleware guards this route to COORDINATOR | ADMIN roles only.
 * The client component (WarRoomDashboard) handles the real-time data.
 */

import type { Metadata } from 'next';
import { WarRoomDashboard } from '@/components/coordinator/WarRoomDashboard';

export const metadata: Metadata = {
  title: 'War Room',
  description: 'Real-time disaster coordination dashboard for RahatNet coordinators.',
};

export default function WarRoomPage() {
  const disasterEventId =
    process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'demo-disaster-001';

  return <WarRoomDashboard disasterEventId={disasterEventId} />;
}
