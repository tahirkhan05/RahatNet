/**
 * /citizen/report — citizen need reporting page.
 *
 * Server-component shell; all interactivity lives in ReportPageClient.
 * Middleware redirects unauthenticated users to /login before this renders.
 */

import type { Metadata } from 'next';
import { ReportPageClient } from '@/components/citizen/ReportPageClient';

export const metadata: Metadata = {
  title: 'Report a Need',
  description: 'Tell us what help is needed. Report food, rescue, medicine, or shelter needs.',
};

export default function ReportPage() {
  return <ReportPageClient />;
}
