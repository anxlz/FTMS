import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { currentUser, homeFor } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('start'))('title') };
}

/**
 * The signed-out landing screen (Phase 8; where the Android app opens): Log In,
 * or Continue as Guest to record attendance without an account.
 */
export default async function StartPage() {
  const user = await currentUser();
  if (user) redirect(homeFor(user));
  const t = await getTranslations('start');
  return (
    <AuthCard title={t('title')} intro={t('intro')}>
      <div className="stack">
        <Link href="/login" className="btn btn-primary btn-large">
          {t('logIn')}
        </Link>
        <Link href="/guest" className="btn btn-secondary btn-large">
          {t('continueAsGuest')}
        </Link>
        <p className="muted small">{t('guestNote')}</p>
      </div>
    </AuthCard>
  );
}
