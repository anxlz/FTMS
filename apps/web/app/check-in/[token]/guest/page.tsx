import type { Metadata } from 'next';
import Link from 'next/link';
import { type GuestCheckInContext } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { dayValue } from '@/lib/calendar';
import { GuestCheckInForm } from './guest-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('guest'))('formTitle') };
}

/**
 * Guest attendance for one visit (Phase 8): no sign-in. Shows only what is safe
 * for anyone holding the QR code — the visit's title, day, time, place and the
 * window — then the form: typed full name and seat number (not verified) and the
 * device location. The server decides the result.
 */
export default async function GuestCheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations('guest');
  const result = await apiFetch<GuestCheckInContext>('/attendance/guest/context', {
    method: 'POST',
    body: { token },
  });
  if (!result.ok) {
    const te = await getTranslations('errors');
    return (
      <AuthCard title={t('formTitle')}>
        <p className="alert alert-error" role="alert">
          {te.has(result.code) ? te(result.code, { minutes: 1 }) : te('INTERNAL_ERROR')}
        </p>
        <p>
          <Link href="/guest">{t('scanAnother')}</Link>
        </p>
      </AuthCard>
    );
  }
  const c = result.data;
  const format = await getFormatter();
  const clock = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
  return (
    <AuthCard title={t('formTitle')}>
      <GuestCheckInForm
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
      <p className="small">
        <Link href={`/login?next=${encodeURIComponent(`/check-in/${encodeURIComponent(token)}`)}`}>
          {t('signInInstead')}
        </Link>
      </p>
    </AuthCard>
  );
}
