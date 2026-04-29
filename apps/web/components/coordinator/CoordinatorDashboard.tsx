'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  LogOut,
  Trash2,
  User,
  Loader2,
  LayoutDashboard,
  Users,
  Package,
  AlertTriangle,
  Zap,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import type { Language } from '@rahatnet/types';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useLang } from '@/lib/i18n/LanguageContext';
import type { LangCode } from '@/lib/i18n/translations';

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
          This permanently deletes your coordinator account and all associated data.
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

export function CoordinatorDashboard() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [showDeleteModal, setShowDeleteModal] = React.useState(false);
  const [deletingAccount, setDeletingAccount] = React.useState(false);
  const [processing, setProcessing] = React.useState(false);
  const [processResult, setProcessResult] = React.useState<string | null>(null);
  const [pendingCount, setPendingCount] = React.useState(0);

  // Listen for new pending rawReports and show count
  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      const { collection, query, where, onSnapshot, getFirestore } =
        await import('firebase/firestore');
      const { firebaseApp } = await import('@/lib/firebase/client');
      const db = getFirestore(firebaseApp);
      unsub = onSnapshot(
        query(collection(db, 'rawReports'), where('status', '==', 'PENDING')),
        (snap) => setPendingCount(snap.size),
      );
    })();
    return () => unsub?.();
  }, []);

  const handleProcessReports = async () => {
    setProcessing(true);
    setProcessResult(null);
    try {
      const res = await fetch('/api/coordinator/bootstrap', { method: 'POST' });
      const json = (await res.json()) as { data?: { promoted: number } };
      const n = json.data?.promoted ?? 0;
      const geminiActive = !!process.env['NEXT_PUBLIC_ENV']; // Always true in dev
      setProcessResult(
        n === 0
          ? 'No new reports to process.'
          : `${n} report${n !== 1 ? 's' : ''} processed${n > 0 ? ' with AI urgency scoring' : ''}.`,
      );
    } catch {
      setProcessResult('Failed to process reports.');
    } finally {
      setProcessing(false);
    }
  };

  const { lang, setLang } = useLang();
  const displayName = user?.displayName || user?.phoneNumber || '';
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  const org = (user as { organizationName?: string })?.organizationName ?? '';

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
            <p className="text-foreground font-medium">{displayName || 'Coordinator'}</p>
            <p className="text-muted-foreground text-xs">{org || 'Coordinator'}</p>
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

      {/* Primary action */}
      <Link
        href="/coordinator/war-room"
        className="bg-primary text-primary-foreground flex w-full items-center justify-between rounded-2xl p-5 shadow-sm transition-opacity hover:opacity-90"
      >
        <div>
          <p className="text-lg font-semibold">War Room</p>
          <p className="text-primary-foreground/80 mt-0.5 text-sm">
            Live disaster coordination dashboard
          </p>
        </div>
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20">
          <LayoutDashboard className="h-6 w-6" />
        </div>
      </Link>

      {/* Quick links */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { href: '/coordinator/needs', icon: AlertTriangle, label: 'Needs', sub: 'Active needs' },
          { href: '/coordinator/volunteers', icon: Users, label: 'Volunteers', sub: 'Manage team' },
          {
            href: '/coordinator/resources',
            icon: Package,
            label: 'Resources',
            sub: 'Track assets',
          },
        ].map(({ href, icon: Icon, label, sub }) => (
          <Link
            key={href}
            href={href}
            className="border-border bg-card hover:bg-accent flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors"
          >
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
              <Icon className="text-primary h-5 w-5" />
            </div>
            <span className="text-foreground text-sm font-medium">{label}</span>
            <span className="text-muted-foreground text-center text-xs">{sub}</span>
          </Link>
        ))}
      </div>

      {/* Process pending reports */}
      <div className="border-border bg-card overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between px-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-foreground text-sm font-medium">Process citizen reports</p>
              {pendingCount > 0 && (
                <span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-[10px] font-bold">
                  {pendingCount} new
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {pendingCount > 0
                ? `${pendingCount} report${pendingCount !== 1 ? 's' : ''} waiting to be promoted`
                : 'Promote pending reports to the needs queue'}
            </p>
          </div>
          <button
            onClick={() => void handleProcessReports()}
            disabled={processing}
            className="bg-primary text-primary-foreground hover:bg-primary/90 ml-3 flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60"
          >
            {processing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Process
          </button>
        </div>
        {processResult && (
          <div
            className={`border-border border-t px-4 py-2.5 text-xs ${processResult.includes('Failed') ? 'text-destructive' : 'text-green-600 dark:text-green-400'}`}
          >
            {processResult}
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
