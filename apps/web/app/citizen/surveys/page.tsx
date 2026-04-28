'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Clock, Loader2, ClipboardList } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface SurveySummary {
  id: string;
  needType: string;
  status: string;
  description: string;
  createdAt: number;
}

export default function SurveysPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const [surveys, setSurveys] = React.useState<SurveySummary[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace('/login');
      return;
    }
  }, [isLoading, isAuthenticated, router]);

  React.useEffect(() => {
    if (!user?.uid) return;
    let unsub: (() => void) | undefined;

    void (async () => {
      try {
        const { collection, query, where, orderBy, onSnapshot, getFirestore } =
          await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const db = getFirestore(firebaseApp);
        const q = query(
          collection(db, 'rawReports'),
          where('reporterId', '==', user.uid),
          orderBy('createdAt', 'desc'),
        );
        unsub = onSnapshot(q, (snap) => {
          const docs = snap.docs
            .filter((d) => (d.data()['source'] ?? 'CITIZEN') === 'SURVEY')
            .map((d) => {
              const data = d.data();
              return {
                id: d.id,
                needType: (data['type'] as string) ?? 'FOOD',
                status: (data['status'] as string) ?? 'PENDING',
                description: (data['description'] as string) ?? '',
                createdAt: (data['createdAt']?.toMillis?.() ?? Date.now()) as number,
              };
            });
          setSurveys(docs);
          setLoading(false);
        });
      } catch {
        setLoading(false);
      }
    })();

    return () => unsub?.();
  }, [user?.uid]);

  if (isLoading || loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/citizen"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1 rounded-lg p-1.5"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-foreground text-xl font-semibold">My Surveys</h1>
        <span className="text-muted-foreground ml-auto text-sm">{surveys.length} submitted</span>
      </div>

      {surveys.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed p-10 text-center">
          <ClipboardList className="text-muted-foreground/50 mx-auto mb-2 h-10 w-10" />
          <p className="text-muted-foreground text-sm">No community surveys yet</p>
          <Link
            href="/citizen/report?mode=survey"
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-3 inline-block rounded-lg px-4 py-2 text-sm font-medium"
          >
            Start a survey
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {surveys.map((s) => (
            <Link
              key={s.id}
              href={`/citizen/surveys/${s.id}`}
              className="border-border bg-card hover:bg-accent block rounded-xl border p-4 transition-colors"
            >
              <div className="flex flex-wrap items-center gap-2">
                <ClipboardList className="text-muted-foreground h-4 w-4 shrink-0" />
                <span className="text-foreground font-medium capitalize">
                  {s.needType.replace(/_/g, ' ').toLowerCase()} — survey
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    s.status === 'PENDING'
                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                      : s.status === 'PROCESSED'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {s.status === 'PENDING'
                    ? 'Submitted'
                    : s.status === 'PROCESSED'
                      ? 'Mapped'
                      : s.status}
                </span>
              </div>
              <p className="text-muted-foreground mt-2 line-clamp-2 text-sm">{s.description}</p>
              <div className="text-muted-foreground mt-2 flex items-center gap-1 text-xs">
                <Clock className="h-3 w-3" />
                {new Date(s.createdAt).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
