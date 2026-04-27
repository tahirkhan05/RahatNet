import type { Metadata } from 'next';
import { VolunteerTasksClient } from '@/components/volunteer/VolunteerTasksClient';

export const metadata: Metadata = {
  title: 'My Tasks',
  description: 'View and manage your assigned disaster-relief tasks.',
};

export default function TasksPage() {
  return <VolunteerTasksClient />;
}
