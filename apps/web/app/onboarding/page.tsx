import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/auth/OnboardingWizard';

export const metadata: Metadata = {
  title: 'Get Started',
  description: 'Complete your profile to start using RahatNet.',
};

export default function OnboardingPage() {
  return (
    <div className="rn-card space-y-6">
      <OnboardingWizard />
    </div>
  );
}
