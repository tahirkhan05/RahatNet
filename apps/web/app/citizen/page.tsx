import type { Metadata } from 'next';
import { CitizenDashboard } from '@/components/citizen/CitizenDashboard';

export const metadata: Metadata = {
  title: 'Home',
  description: 'Report a need, track your reports, and get help.',
};

export default function CitizenHomePage() {
  return <CitizenDashboard />;
}
