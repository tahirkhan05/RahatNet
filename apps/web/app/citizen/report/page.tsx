/**
 * /citizen/report — citizen need reporting page.
 *
 * Server-component shell; all interactivity lives in ReportPageClient.
 * Middleware redirects unauthenticated users to /login before this renders.
 *
 * ?mode=survey  → renders the NGO community survey form
 * (default)     → renders the real-time crisis report form
 */

import type { Metadata } from 'next';
import { ReportPageClient } from '@/components/citizen/ReportPageClient';

export const metadata: Metadata = {
  title: 'Report a Need',
  description: 'Tell us what help is needed. Report food, rescue, medicine, or shelter needs.',
};

interface Props {
  searchParams: Record<string, string | string[] | undefined>;
}

export default function ReportPage({ searchParams }: Props) {
  const mode = searchParams['mode'] === 'survey' ? 'survey' : 'crisis';
  return <ReportPageClient mode={mode} />;
}
