import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { currentUser, homeFor } from '@/lib/auth/session';
import { logoutAction } from '@/lib/auth/actions';
import { PasswordForm } from '@/components/password-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.setPassword'))('titleFirst') };
}

/**
 * Reached right after a first sign-in by email code (no password yet) or with a
 * temporary password (seeded Super Admin, §2). The API blocks every other route
 * until this step is done; this page only presents it.
 */
export default async function SetPasswordPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.passwordSetupRequired) redirect(homeFor(user));
  const t = await getTranslations('auth.setPassword');
  const tc = await getTranslations('common');
  const first = !user.hasPassword;
  return (
    <AuthCard
      title={first ? t('titleFirst') : t('titleForced')}
      intro={first ? t('introFirst') : t('introForced')}
    >
      <p className="muted" dir="ltr">
        {user.email}
      </p>
      <PasswordForm requireCurrent={user.hasPassword} next="/dashboard" />
      <form action={logoutAction}>
        <button type="submit" className="btn btn-link">
          {tc('signOut')}
        </button>
      </form>
    </AuthCard>
  );
}
