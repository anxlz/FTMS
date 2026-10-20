import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { currentUser } from '@/lib/auth/session';
import { LoginForms } from './login-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.login'))('title') };
}

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect(user.passwordSetupRequired ? '/set-password' : '/dashboard');
  const t = await getTranslations('auth.login');
  return (
    <AuthCard title={t('title')} intro={t('subtitle')}>
      <LoginForms />
    </AuthCard>
  );
}
