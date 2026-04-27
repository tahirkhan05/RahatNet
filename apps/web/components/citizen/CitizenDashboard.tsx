'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ClipboardList,
  Plus,
  LogOut,
  Trash2,
  ChevronRight,
  User,
  Clock,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useLang } from '@/lib/i18n/LanguageContext';
import type { LangCode } from '@/lib/i18n/translations';
import type { Language } from '@rahatnet/types';
import { useAuth } from '@/hooks/useAuth';
import { NeedStatus, UserRole } from '@rahatnet/types';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDING:     { label: 'Submitted',       color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300' },
  PROCESSING:  { label: 'Processing',      color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  VERIFIED:    { label: 'Verified',        color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300' },
  ASSIGNED:    { label: 'Help on the way', color: 'bg-primary/10 text-primary' },
  IN_PROGRESS: { label: 'In progress',     color: 'bg-primary/10 text-primary' },
  RESOLVED:    { label: 'Resolved',        color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  DUPLICATE:   { label: 'Duplicate',       color: 'bg-muted text-muted-foreground' },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Report card (lightweight — no full CanonicalNeed needed)
// ---------------------------------------------------------------------------

interface ReportSummary {
  id: string;
  needType: string;
  status: string;
  description: string;
  createdAt: number;
}

function ReportCard({ report, onDelete }: { report: ReportSummary; onDelete: (id: string) => void }) {
  const date = new Date(report.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const isDeletable = report.status === 'PENDING' || report.status === 'DUPLICATE';

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <Link href="/citizen/status" className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground capitalize">
              {report.needType.replace(/_/g, ' ').toLowerCase()}
            </span>
            <StatusBadge status={report.status} />
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{report.description}</p>
          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {date}
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          {isDeletable && (
            <button
              onClick={() => onDelete(report.id)}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete report"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <Link href="/citizen/status" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent">
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete account modal
// ---------------------------------------------------------------------------

function DeleteAccountModal({ onClose, onConfirm, loading }: {
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
            <Trash2 className="h-5 w-5 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Delete account</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          This will permanently delete your account and all your submitted reports. This action cannot be undone.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export function CitizenDashboard() {
  const { user, logout } = useAuth();
  const router = useRouter();

  const [reports, setReports] = React.useState<ReportSummary[]>([]);
  const [loadingReports, setLoadingReports] = React.useState(true);
  const [showDeleteModal, setShowDeleteModal] = React.useState(false);
  const [deletingAccount, setDeletingAccount] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [reportToDelete, setReportToDelete] = React.useState<string | null>(null);
  const [deletingReport, setDeletingReport] = React.useState(false);
  const [deleteReportError, setDeleteReportError] = React.useState<string | null>(null);

  // Load user's reports from Firestore
  React.useEffect(() => {
    if (!user?.uid) return;

    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const { collection, query, where, orderBy, limit, onSnapshot, getFirestore } =
          await import('firebase/firestore');
        const { firebaseApp } = await import('@/lib/firebase/client');

        const db = getFirestore(firebaseApp);
        const q = query(
          collection(db, 'rawReports'),
          where('reporterId', '==', user.uid),
          orderBy('createdAt', 'desc'),
          limit(10),
        );

        unsubscribe = onSnapshot(q, (snap) => {
          const docs = snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              needType: (data['needType'] as string) ?? 'RESCUE',
              status: (data['status'] as string) ?? 'PENDING',
              description: (data['description'] as string) ?? '',
              createdAt: (data['createdAt']?.toMillis?.() ?? Date.now()) as number,
            };
          });
          setReports(docs);
          setLoadingReports(false);
        });
      } catch {
        setLoadingReports(false);
      }
    })();

    return () => unsubscribe?.();
  }, [user?.uid]);

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
    router.replace('/login');
  };

  const handleDeleteReport = async () => {
    if (!reportToDelete) return;
    setDeletingReport(true);
    setDeleteReportError(null);
    try {
      const res = await fetch(`/api/needs/${reportToDelete}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json() as { error?: { message?: string } };
        throw new Error(json.error?.message ?? 'Failed to delete report.');
      }
      setReportToDelete(null);
    } catch (err) {
      setDeleteReportError(err instanceof Error ? err.message : 'Failed to delete report.');
    } finally {
      setDeletingReport(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      // 1. Delete via server API (cleans up Firestore profile + raw reports)
      const res = await fetch('/api/auth/account', { method: 'DELETE' });
      if (!res.ok) throw new Error('Server deletion failed');

      // 2. Delete Firebase Auth user client-side
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

  const { lang, setLang, t: tl } = useLang();
  const displayName = user?.displayName || user?.phoneNumber || 'Citizen';
  const initials = displayName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" className="h-10 w-10 rounded-full object-cover" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initials || <User className="h-5 w-5" />}
            </div>
          )}
          <div>
            <p className="font-medium text-foreground">{displayName}</p>
            <p className="text-xs text-muted-foreground">Citizen</p>
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
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {loggingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            {tl('common.sign_out')}
          </button>
        </div>
      </div>

      {/* Primary action */}
      <Link
        href="/citizen/report"
        className="flex w-full items-center justify-between rounded-2xl bg-primary p-5 text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
      >
        <div>
          <p className="text-lg font-semibold">{tl('citizen.home.report_button')}</p>
          <p className="mt-0.5 text-sm text-primary-foreground/80">
            {tl('citizen.home.report_sub')}
          </p>
        </div>
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/20">
          <Plus className="h-6 w-6" />
        </div>
      </Link>

      {/* Reports section */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">{tl('citizen.home.my_reports')}</h2>
          {reports.length > 0 && (
            <Link href="/citizen/status" className="text-sm text-primary hover:underline">
              {tl('citizen.home.view_all')}
            </Link>
          )}
        </div>

        {loadingReports ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <ClipboardList className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No reports yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Use the button above to report a need
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((r) => (
              <ReportCard key={r.id} report={r} onDelete={(id) => { setReportToDelete(id); setDeleteReportError(null); }} />
            ))}
          </div>
        )}
      </div>

      {/* Account actions */}
      <div className="rounded-xl border border-border bg-card">
        <button
          onClick={() => setShowDeleteModal(true)}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-sm text-destructive hover:bg-destructive/5 rounded-xl"
        >
          <Trash2 className="h-4 w-4" />
          {tl('common.delete_account')}
        </button>
      </div>

      {/* Delete report confirm */}
      {reportToDelete !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">Delete report?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This will permanently remove your report. Only pending reports can be deleted.
            </p>
            {deleteReportError && (
              <p className="mt-2 text-sm text-destructive">{deleteReportError}</p>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => { setReportToDelete(null); setDeleteReportError(null); }}
                disabled={deletingReport}
                className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteReport}
                disabled={deletingReport}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-2.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
              >
                {deletingReport && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

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
