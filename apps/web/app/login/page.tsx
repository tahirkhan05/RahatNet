import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/LoginForm';

export const metadata: Metadata = {
  title: 'Sign In',
  description: 'Sign in to RahatNet to report needs, coordinate volunteers, and save lives.',
};

export default function LoginPage() {
  return (
    <div className="rn-card space-y-6">
      {/* Header */}
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">RahatNet</h1>
        <p className="text-sm text-muted-foreground">AI-powered disaster coordination</p>
      </div>

      {/* Form */}
      <LoginForm />
    </div>
  );
}
