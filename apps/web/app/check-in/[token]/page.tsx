import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { type CheckInContext } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, currentUser, homeFor } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
import { CheckInPanel } from './check-in-panel';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkIn'))('title') };
}

/**
 * Where a scanned attendance QR code lands (§7.2, Phase 8). The code only names
 * the visit. Signed out: choose to sign in or to continue as a guest. Signed in:
 * the group, the time window and the location are checked by the API when the
 * student confirms. Biometrics are never part of attendance.
 */
export default async function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const here = `/check-in/${encodeURIComponent(token)}`;
  const user = await currentUser();
  const t = await getTranslations('checkIn');
  if (!user) {
    return (
      <AuthCard title={t('title')} intro={t('chooseIntro')}>
        <div className="stack">
          <Link
            href={`/login?next=${encodeURIComponent(here)}`}
            className="btn btn-primary btn-large"
          >
            {t('logIn')}
          </Link>
          <Link href={`${here}/guest`} className="btn btn-secondary btn-large">
            {t('continueAsGuest')}
          </Link>
          <p className="muted small">{t('guestNote')}</p>
        </div>
      </AuthCard>
    );
  }
  if (user.passwordSetupRequired || user.status === 'PENDING_VERIFICATION') {
    redirect(homeFor(user));
  }

  if (user.role !== 'STUDENT') {
    return (
      <AuthCard title={t('title')}>
        <p className="alert alert-info">{t('staffNote')}</p>
        <p>
          <Link href="/attendance">{t('openAttendance')}</Link>
        </p>
      </AuthCard>
    );
  }

  const result = await apiFetch<CheckInContext>(
    `/attendance/check-in/${encodeURIComponent(token)}`,
    {
      accessToken: await accessToken(),
    },
  );
  if (!result.ok) {
    const te = await getTranslations('errors');
    return (
      <AuthCard title={t('title')}>
        <p className="alert alert-error" role="alert">
          {te.has(result.code) ? te(result.code, { minutes: 1 }) : te('INTERNAL_ERROR')}
        </p>
        <p>
          <Link href="/dashboard">{t('toDashboard')}</Link>
        </p>
      </AuthCard>
    );
  }

  const c = result.data;
  const format = await getFormatter();
  const clock = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
  return (
    <AuthCard title={t('title')}>
      <CheckInPanel
        token={token}
        context={c}
        text={{
          date: format.dateTime(dayValue(c.visit.date), { dateStyle: 'full' }),
          time: timeRange(c.visit),
          opensAt: clock(c.window.opensAt),
          onTimeUntil: clock(new Date(Date.parse(c.window.onTimeUntil) - 60_000).toISOString()),
          closesAt: clock(new Date(Date.parse(c.window.closesAt) - 60_000).toISOString()),
          serverTime: clock(c.serverTime),
        }}
      />
      <p>
        <Link href="/dashboard">{t('toDashboard')}</Link>
      </p>
    </AuthCard>
  );
}
