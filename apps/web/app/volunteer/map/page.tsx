import type { Metadata } from 'next';
import { VolunteerMapClient } from '@/components/volunteer/VolunteerMapClient';

export const metadata: Metadata = {
  title: 'Navigation',
  description: 'Navigate to your assigned task location.',
};

export default function VolunteerMapPage() {
  return (
    <div className="h-screen w-full overflow-hidden">
      <VolunteerMapClient />
    </div>
  );
}
