import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { ForgotPasswordForm } from './forgot-password-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.forgot'))('title') };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth.forgot');
  return (
    <AuthCard title={t('title')} intro={t('intro')}>
      <ForgotPasswordForm />
    </AuthCard>
  );
}
