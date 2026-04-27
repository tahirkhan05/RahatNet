import type { Metadata } from 'next';
import { CoordinatorDashboard } from '@/components/coordinator/CoordinatorDashboard';

export const metadata: Metadata = { title: 'Home' };

export default function CoordinatorHomePage() {
  return <CoordinatorDashboard />;
}
