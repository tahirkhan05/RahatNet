'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { UserRole } from '@rahatnet/types';

const BACK_LABEL: Record<string, string> = {
  '/volunteer/tasks': 'Back',
  '/volunteer/map': 'Back',
  '/volunteer/navigate': 'Back',
};

export default function VolunteerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Navigate page has its own back button overlay
  const showBack = pathname !== '/volunteer' && !pathname.startsWith('/volunteer/navigate');

  return (
    <RoleGuard roles={[UserRole.VOLUNTEER, UserRole.COORDINATOR, UserRole.ADMIN]} redirectTo="/login">
    <div className="min-h-screen bg-background md:bg-muted/30">
      {showBack && (
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
            <Link href="/volunteer"
              className="flex items-center gap-1.5 rounded-lg p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              <span>{BACK_LABEL[pathname] ?? 'Home'}</span>
            </Link>
          </div>
        </header>
      )}
      {pathname.startsWith('/volunteer/navigate') || pathname === '/volunteer/map' ? (
        <main className="flex-1 overflow-hidden">{children}</main>
      ) : (
        <main className="mx-auto w-full max-w-lg px-4 pb-24 pt-6 md:py-10">
          <div className="md:rounded-2xl md:border md:border-border md:bg-card md:p-8 md:shadow-sm">
            {children}
          </div>
        </main>
      )}
    </div>
    </RoleGuard>
  );
}
