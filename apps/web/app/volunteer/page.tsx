import type { Metadata } from 'next';
import { VolunteerDashboard } from '@/components/volunteer/VolunteerDashboard';

export const metadata: Metadata = { title: 'Home' };

export default function VolunteerHomePage() {
  return <VolunteerDashboard />;
}
