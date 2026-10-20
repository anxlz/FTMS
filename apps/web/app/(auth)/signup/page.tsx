import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { currentUser, homeFor } from '@/lib/auth/session';
import { SignupForm } from './signup-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.signup'))('title') };
}

export default async function SignupPage() {
  const user = await currentUser();
  if (user) redirect(homeFor(user));
  const t = await getTranslations('auth.signup');
  return (
    <AuthCard title={t('title')} intro={t('intro')}>
      <SignupForm />
    </AuthCard>
  );
}
