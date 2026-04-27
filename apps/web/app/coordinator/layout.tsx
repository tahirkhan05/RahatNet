'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { UserRole } from '@rahatnet/types';

const BACK_LABEL: Record<string, string> = {
  '/coordinator/war-room': 'Back',
  '/coordinator/needs': 'Back',
  '/coordinator/volunteers': 'Back',
  '/coordinator/resources': 'Back',
};

export default function CoordinatorLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // War room is fullscreen — no layout wrapper
  const isWarRoom = pathname === '/coordinator/war-room';
  const showBack = pathname !== '/coordinator' && !isWarRoom;

  if (isWarRoom) {
    return (
      <RoleGuard roles={[UserRole.COORDINATOR, UserRole.ADMIN]} redirectTo="/login">
        {children}
      </RoleGuard>
    );
  }

  return (
    <RoleGuard roles={[UserRole.COORDINATOR, UserRole.ADMIN]} redirectTo="/login">
    <div className="min-h-screen bg-background">
      {showBack && (
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
            <Link href="/coordinator"
              className="flex items-center gap-1.5 rounded-lg p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              <span>{BACK_LABEL[pathname] ?? 'Home'}</span>
            </Link>
          </div>
        </header>
      )}
      <main className="mx-auto w-full max-w-2xl px-4 pb-24 pt-6 md:py-10">
        <div className="md:rounded-2xl md:border md:border-border md:bg-card md:p-8 md:shadow-sm">
          {children}
        </div>
      </main>
    </div>
    </RoleGuard>
  );
}
