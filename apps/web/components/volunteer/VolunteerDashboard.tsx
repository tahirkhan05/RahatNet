'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  LogOut,
  Trash2,
  User,
  Loader2,
  HandHeart,
  Map,
  ToggleLeft,
  ToggleRight,
  Pencil,
  Check,
  X,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useVolunteerStore } from '@/store/volunteerStore';
import { VolunteerSkill } from '@rahatnet/types';
import type { Language } from '@rahatnet/types';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useLang } from '@/lib/i18n/LanguageContext';
import type { LangCode } from '@/lib/i18n/translations';

const ALL_SKILLS = Object.values(VolunteerSkill);
const SKILL_LABELS: Record<VolunteerSkill, string> = {
  [VolunteerSkill.BOAT_OPERATOR]: '🚤 Boat Operator',
  [VolunteerSkill.DOCTOR]: '🩺 Doctor',
  [VolunteerSkill.NURSE]: '💉 Nurse',
  [VolunteerSkill.COOK]: '🍳 Cook',
  [VolunteerSkill.TRANSLATOR]: '🌐 Translator',
  [VolunteerSkill.RESCUE_SWIMMER]: '🏊 Rescue Swimmer',
  [VolunteerSkill.DRIVER]: '🚗 Driver',
  [VolunteerSkill.COUNSELLOR]: '🧠 Counsellor',
  [VolunteerSkill.ELECTRICIAN]: '⚡ Electrician',
  [VolunteerSkill.CARPENTER]: '🔨 Carpenter',
};

function ActiveTaskBanner() {
  const [hasActiveTask, setHasActiveTask] = React.useState(false);
  const [taskTitle, setTaskTitle] = React.useState('');
  const { user } = useAuth();

  React.useEffect(() => {
    if (!user?.uid) return;
    let unsub: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, limit, onSnapshot, getFirestore } =
        await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      const q = query(
        collection(db, 'assignments'),
        where('volunteerId', '==', user.uid),
        limit(10),
      );
      unsub = onSnapshot(q, async (snap) => {
        const active = snap.docs.find((d) => {
          const s = d.data()['status'] as string;
          return s === 'NOTIFIED' || s === 'ACCEPTED' || s === 'IN_PROGRESS' || s === 'CREATED';
        });
        if (active) {
          setHasActiveTask(true);
          const assignment = active.data();
          if (assignment?.['needId']) {
            const { doc, getDoc } = await import('firebase/firestore');
            const needDoc = await getDoc(doc(db, 'needs', assignment['needId'] as string));
            if (needDoc.exists()) setTaskTitle((needDoc.data()['title'] as string) ?? 'New task');
          }
        } else {
          setHasActiveTask(false);
          setTaskTitle('');
        }
      });
    })();
    return () => unsub?.();
  }, [user?.uid]);

  if (!hasActiveTask) {
    return (
      <div className="border-border rounded-xl border border-dashed p-4 text-center">
        <p className="text-muted-foreground text-sm">No tasks assigned yet</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Express interest in tasks below to get assigned
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-green-500/50 bg-green-500/10">
      {/* Task info */}
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
            ✓ Coordinator assigned you
          </span>
        </div>
        <p className="text-foreground font-semibold">{taskTitle || 'New task assigned'}</p>
        <p className="text-muted-foreground mt-0.5 text-sm">Tap Navigate to go to the location</p>
      </div>
      {/* Actions */}
      <div className="grid grid-cols-2 border-t border-green-500/20">
        <Link
          href="/volunteer/tasks"
          className="text-primary flex items-center justify-center gap-2 border-r border-green-500/20 py-3 text-sm font-semibold hover:bg-green-500/10"
        >
          <Map className="h-4 w-4" /> View details
        </Link>
        <Link
          href="/volunteer/tasks"
          className="flex items-center justify-center gap-2 py-3 text-sm font-semibold text-green-600 hover:bg-green-500/10 dark:text-green-400"
        >
          <ChevronRight className="h-4 w-4" /> Navigate
        </Link>
      </div>
    </div>
  );
}

function DeleteAccountModal({
  onClose,
  onConfirm,
  loading,
}: {
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="border-border bg-card w-full max-w-sm rounded-2xl border p-6 shadow-xl">
        <h2 className="text-foreground text-lg font-semibold">Delete account?</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          This permanently deletes your account and all your data. Cannot be undone.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="border-border text-foreground hover:bg-accent flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function VolunteerDashboard() {
  const { user, logout } = useAuth();
  const { isAvailable, setAvailability } = useVolunteerStore();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [showDeleteModal, setShowDeleteModal] = React.useState(false);
  const [deletingAccount, setDeletingAccount] = React.useState(false);
  const [togglingAvail, setTogglingAvail] = React.useState(false);

  // Always seed from Firestore on mount — handles page refresh
  React.useEffect(() => {
    if (!user?.uid) return;
    void (async () => {
      try {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');
        const snap = await getDoc(doc(getFirestore(firebaseApp), 'users', user.uid));
        if (snap.exists()) setAvailability(snap.data()['isAvailable'] === true);
      } catch {
        /* silent */
      }
    })();
  }, [user?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const { lang, setLang } = useLang();
  const displayName = user?.displayName || user?.phoneNumber || '';
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const handleToggleAvailability = async () => {
    setTogglingAvail(true);
    const next = !isAvailable;
    setAvailability(next); // Optimistic update in Zustand volunteerStore
    try {
      const res = await fetch('/api/volunteers/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAvailable: next }),
      });
      if (!res.ok) throw new Error('Failed');
      // Also update Firestore directly so authStore profile stays consistent
      const { doc, updateDoc, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      if (user?.uid) {
        await updateDoc(doc(getFirestore(firebaseApp), 'users', user.uid), {
          isAvailable: next,
          availabilityStatus: next ? 'AVAILABLE' : 'UNAVAILABLE',
        });
      }
    } catch {
      setAvailability(!next); // Rollback
    } finally {
      setTogglingAvail(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
    router.replace('/login');
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await fetch('/api/auth/account', { method: 'DELETE' });
      const { deleteUser, getAuth } = await import('firebase/auth');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const auth = getAuth(firebaseApp);
      if (auth.currentUser) await deleteUser(auth.currentUser);
      await logout();
      router.replace('/login');
    } catch {
      setDeletingAccount(false);
      setShowDeleteModal(false);
    }
  };

  const skills = (user as { skills?: VolunteerSkill[] })?.skills ?? [];
  const [editingSkills, setEditingSkills] = React.useState(false);
  const [draftSkills, setDraftSkills] = React.useState<VolunteerSkill[]>(skills);
  const [savingSkills, setSavingSkills] = React.useState(false);

  const toggleDraftSkill = (skill: VolunteerSkill) => {
    setDraftSkills((prev) =>
      prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill],
    );
  };

  const handleSaveSkills = async () => {
    setSavingSkills(true);
    try {
      const { collection, doc, updateDoc, getFirestore } = await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      await updateDoc(doc(collection(db, 'users'), user!.uid), { skills: draftSkills });
      setEditingSkills(false);
    } catch {
      // silent — skills will reload on next sign-in
    } finally {
      setSavingSkills(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" className="h-10 w-10 rounded-full object-cover" />
          ) : (
            <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold">
              {initials || <User className="h-5 w-5" />}
            </div>
          )}
          <div>
            <p className="text-foreground font-medium">{displayName || 'Volunteer'}</p>
            <p className="text-muted-foreground text-xs">Volunteer</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <LanguageSelector
            variant="compact"
            value={lang as unknown as Language}
            onChange={(l) => setLang(l as unknown as LangCode)}
          />
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm"
          >
            {loggingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            Sign out
          </button>
        </div>
      </div>

      {/* Availability toggle */}
      <button
        onClick={handleToggleAvailability}
        disabled={togglingAvail}
        className={[
          'flex w-full items-center justify-between rounded-2xl p-5 transition-colors',
          isAvailable
            ? 'border border-green-500/30 bg-green-500/10'
            : 'bg-muted border-border border',
        ].join(' ')}
      >
        <div>
          <p
            className={`text-lg font-semibold ${isAvailable ? 'text-green-600 dark:text-green-400' : 'text-foreground'}`}
          >
            {isAvailable ? 'Available for tasks' : 'Currently unavailable'}
          </p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {isAvailable ? 'You will receive task assignments' : 'Toggle on to receive assignments'}
          </p>
        </div>
        {togglingAvail ? (
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        ) : isAvailable ? (
          <ToggleRight className="h-8 w-8 text-green-500" />
        ) : (
          <ToggleLeft className="text-muted-foreground h-8 w-8" />
        )}
      </button>

      {/* Assigned Tasks section */}
      <div>
        <h2 className="text-muted-foreground mb-2 text-sm font-semibold uppercase tracking-wide">
          Assigned to you
        </h2>
        <ActiveTaskBanner />
      </div>

      {/* Available Tasks section */}
      <div>
        <h2 className="text-muted-foreground mb-2 text-sm font-semibold uppercase tracking-wide">
          Browse tasks
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/volunteer/tasks"
            className="border-border bg-card hover:bg-accent flex flex-col gap-2 rounded-xl border p-4 transition-colors"
          >
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
              <HandHeart className="text-primary h-5 w-5" />
            </div>
            <div>
              <p className="text-foreground text-sm font-semibold">Available Tasks</p>
              <p className="text-muted-foreground text-xs">Browse & express interest</p>
            </div>
          </Link>
          <Link
            href="/volunteer/map"
            className="border-border bg-card hover:bg-accent flex flex-col gap-2 rounded-xl border p-4 transition-colors"
          >
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
              <Map className="text-primary h-5 w-5" />
            </div>
            <div>
              <p className="text-foreground text-sm font-semibold">Map View</p>
              <p className="text-muted-foreground text-xs">All needs near you</p>
            </div>
          </Link>
        </div>
      </div>

      {/* Skills */}
      <div className="border-border bg-card rounded-xl border p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-foreground text-sm font-medium">Your skills</p>
          {!editingSkills ? (
            <button
              onClick={() => {
                setDraftSkills(skills);
                setEditingSkills(true);
              }}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setEditingSkills(false)}
                disabled={savingSkills}
                className="text-muted-foreground hover:bg-accent flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
              >
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
              <button
                onClick={handleSaveSkills}
                disabled={savingSkills || draftSkills.length === 0}
                className="bg-primary text-primary-foreground flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium disabled:opacity-60"
              >
                {savingSkills ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save
              </button>
            </div>
          )}
        </div>
        {!editingSkills ? (
          <div className="flex flex-wrap gap-2">
            {skills.length === 0 ? (
              <p className="text-muted-foreground text-xs">No skills added. Tap Edit to add.</p>
            ) : (
              skills.map((skill) => (
                <span
                  key={skill}
                  className="bg-primary/10 text-primary rounded-full px-3 py-1 text-xs font-medium capitalize"
                >
                  {SKILL_LABELS[skill] ?? skill.replace(/_/g, ' ').toLowerCase()}
                </span>
              ))
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ALL_SKILLS.map((skill) => (
              <button
                key={skill}
                type="button"
                onClick={() => toggleDraftSkill(skill)}
                className={[
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  draftSkills.includes(skill)
                    ? 'bg-primary/10 text-primary ring-primary/30 ring-1'
                    : 'bg-muted text-muted-foreground hover:bg-accent',
                ].join(' ')}
              >
                {SKILL_LABELS[skill]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Account */}
      <div className="border-border bg-card rounded-xl border">
        <button
          onClick={() => setShowDeleteModal(true)}
          className="text-destructive hover:bg-destructive/5 flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-sm"
        >
          <Trash2 className="h-4 w-4" />
          Delete account
        </button>
      </div>

      {showDeleteModal && (
        <DeleteAccountModal
          onClose={() => setShowDeleteModal(false)}
          onConfirm={handleDeleteAccount}
          loading={deletingAccount}
        />
      )}
    </div>
  );
}
