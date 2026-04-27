import type { Metadata } from 'next';
import { StatusPageClient } from '@/components/citizen/StatusPageClient';

export const metadata: Metadata = {
  title: 'My Reports',
  description: 'Track the status of your submitted needs and see estimated help arrival times.',
};

export default function StatusPage() {
  return <StatusPageClient />;
}
