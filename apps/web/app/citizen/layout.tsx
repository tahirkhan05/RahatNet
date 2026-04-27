'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { RoleGuard } from '@/components/shared/RoleGuard';
import { UserRole } from '@rahatnet/types';

const BACK_LABEL: Record<string, string> = {
  '/citizen/report': 'Back',
  '/citizen/status': 'Back',
  '/citizen/track': 'Back',
};

export default function CitizenLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isTrack = pathname.startsWith('/citizen/track');
  const showBack = pathname !== '/citizen' && !isTrack;

  return (
    <RoleGuard
      roles={[UserRole.CITIZEN, UserRole.VOLUNTEER, UserRole.COORDINATOR, UserRole.ADMIN]}
      redirectTo="/login"
    >
    <div className={`${isTrack ? 'h-screen overflow-hidden' : 'min-h-screen'} bg-background md:bg-muted/30`}>
      {showBack && (
        <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur md:bg-background">
          <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
            <Link
              href="/citizen"
              className="flex items-center gap-1.5 rounded-lg p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>{BACK_LABEL[pathname] ?? 'Home'}</span>
            </Link>
          </div>
        </header>
      )}
      {isTrack ? (
        <main className="flex-1 overflow-hidden" style={{ height: 'calc(100vh)' }}>{children}</main>
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
