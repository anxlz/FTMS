import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { BiometricSignIn } from '@/components/biometric-sign-in';
import { currentUser, homeFor } from '@/lib/auth/session';
import { safeNext } from '@/lib/safe-next';
import { LoginForms } from './login-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.login'))('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `next`: the page to return to, e.g. a scanned check-in link (§7.2).
  const next = safeNext((await searchParams).next) ?? undefined;
  const user = await currentUser();
  if (user) {
    const home = homeFor(user);
    redirect(home === '/dashboard' && next ? next : home);
  }
  const t = await getTranslations('auth.login');
  return (
    <AuthCard title={t('title')} intro={t('subtitle')}>
      {next?.startsWith('/check-in/') && (
        <p className="alert alert-info" role="status">
          {t('checkInFirst')}
        </p>
      )}
      <LoginForms next={next} />
      <BiometricSignIn next={next} />
    </AuthCard>
  );
}
