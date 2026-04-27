import type { Metadata } from 'next';
import { OtpVerifyForm } from '@/components/auth/OtpVerifyForm';

export const metadata: Metadata = {
  title: 'Enter OTP',
};

export default function VerifyPage() {
  return (
    <div className="rn-card space-y-6">
      <OtpVerifyForm />
    </div>
  );
}
