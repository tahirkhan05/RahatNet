'use client';

import * as React from 'react';
import { CheckCircle2, XCircle, User, Phone, ThumbsUp } from 'lucide-react';

interface VolunteerRow {
  uid: string;
  displayName: string;
  photoURL: string | null;
  isAvailable: boolean;
  skills: string[];
  district: string;
  phoneNumber: string | null;
  interestedNeedIds?: string[];
}

interface NeedRow {
  id: string;
  title: string;
  interestedVolunteerIds?: string[];
}

export default function VolunteersPage() {
  const [volunteers, setVolunteers] = React.useState<VolunteerRow[]>([]);
  const [needs, setNeeds] = React.useState<NeedRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [assigning, setAssigning] = React.useState<string | null>(null);

  const DISASTER_ID = process.env['NEXT_PUBLIC_ACTIVE_DISASTER_ID'] ?? 'active-disaster-001';

  React.useEffect(() => {
    let unsubV: (() => void) | undefined;
    let unsubN: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, onSnapshot, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);

      unsubV = onSnapshot(
        query(collection(db, 'users'), where('role', '==', 'VOLUNTEER')),
        (snap) => {
          setVolunteers(snap.docs.map((d) => {
            const data = d.data();
            return {
              uid: d.id,
              displayName: data['displayName'] ?? 'Unknown',
              photoURL: data['photoURL'] ?? null,
              isAvailable: data['isAvailable'] ?? false,
              skills: data['skills'] ?? [],
              district: data['district'] ?? '',
              phoneNumber: data['phoneNumber'] ?? null,
            };
          }));
          setLoading(false);
        }
      );

      unsubN = onSnapshot(
        query(collection(db, 'needs'), where('disasterEventId', '==', DISASTER_ID)),
        (snap) => {
          setNeeds(snap.docs.map((d) => ({
            id: d.id,
            title: d.data()['title'] ?? 'Need',
            interestedVolunteerIds: d.data()['interestedVolunteerIds'] ?? [],
          })));
        }
      );
    })();
    return () => { unsubV?.(); unsubN?.(); };
  }, [DISASTER_ID]);

  // Map volunteer UID → needs they expressed interest in
  const interestMap = React.useMemo(() => {
    const map: Record<string, NeedRow[]> = {};
    for (const need of needs) {
      for (const uid of need.interestedVolunteerIds ?? []) {
        if (!map[uid]) map[uid] = [];
        map[uid].push(need);
      }
    }
    return map;
  }, [needs]);

  const [assigned, setAssigned] = React.useState<Set<string>>(new Set());

  const handleAssign = async (volunteerId: string, needId: string) => {
    const key = `${volunteerId}-${needId}`;
    setAssigning(key);
    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needId, volunteerId }),
      });
      if (res.ok) {
        setAssigned((prev) => new Set([...prev, key]));
      }
    } finally {
      setAssigning(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Volunteers</h1>
        <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
          {volunteers.filter(v => v.isAvailable).length} available
        </span>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : volunteers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-muted-foreground">No volunteers registered yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {volunteers.map((v) => {
            const interested = interestMap[v.uid] ?? [];
            return (
              <div key={v.uid} className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-center gap-3">
                  {v.photoURL ? (
                    <img src={v.photoURL} alt="" className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <User className="h-5 w-5 text-primary" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground truncate">{v.displayName}</p>
                      {v.isAvailable
                        ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        : <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground">{v.district || 'No district'}</p>
                  </div>
                  {v.phoneNumber && (
                    <a href={`tel:${v.phoneNumber}`}
                      className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent">
                      <Phone className="h-3.5 w-3.5" /> Call
                    </a>
                  )}
                </div>

                {v.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {v.skills.slice(0, 4).map(s => (
                      <span key={s} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground capitalize">
                        {s.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    ))}
                  </div>
                )}

                {interested.length > 0 && (
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <ThumbsUp className="h-3.5 w-3.5" /> Expressed interest in:
                    </p>
                    {interested.map((need) => (
                      <div key={need.id} className="flex items-center justify-between gap-2">
                        <p className="text-sm text-foreground truncate">{need.title}</p>
                        {assigned.has(`${v.uid}-${need.id}`) ? (
                          <span className="shrink-0 rounded-lg bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                            ✓ Assigned
                          </span>
                        ) : (
                          <button
                            onClick={() => void handleAssign(v.uid, need.id)}
                            disabled={assigning === `${v.uid}-${need.id}`}
                            className="shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                          >
                            {assigning === `${v.uid}-${need.id}` ? 'Assigning…' : 'Assign'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
