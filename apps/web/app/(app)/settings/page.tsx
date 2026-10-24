import type { Metadata } from 'next';
import Link from 'next/link';
import { type ProgramState } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { AttendanceDefaultsForm } from '../schedule/schedule-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('settings'))('title') };
}

/**
 * Attendance settings (§10.6, §11.1): the timing defaults new visits start
 * with, the absence allowance and the check-in policy. The Training Director
 * changes them; faculty adjust a single visit's timing on that visit.
 */
export default async function SettingsPage() {
  const user = await requirePermission('attendance.settings.visit', 'attendance.settings.defaults');
  const canDefaults = user.permissions.includes('attendance.settings.defaults');
  const t = await getTranslations();
  const res = await apiFetch<ProgramState>('/program', { accessToken: await accessToken() });
  const program = res.ok ? res.data.program : null;

  return (
    <div className="stack-lg">
      <h1>{t('settings.title')}</h1>
      {!program ? (
        <p className="alert alert-info">{t('schedule.program.missing')}</p>
      ) : (
        <>
          <section className="card stack" aria-labelledby="defaults-title">
            <h2 id="defaults-title">{t('settings.defaults')}</h2>
            <dl className="details">
              <div>
                <dt>{t('schedule.program.timing')}</dt>
                <dd>
                  {t('visits.fields.timingFixed', {
                    opens: program.timing.checkInOpensMinutes,
                    grace: program.timing.graceMinutes,
                    closes: program.timing.checkInClosesMinutes,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('schedule.fields.allowedAbsences')}</dt>
                <dd>{program.allowedAbsences}</dd>
              </div>
              <div>
                <dt>{t('schedule.policy.biometricFallback')}</dt>
                <dd>{t(`schedule.policy.fallback.${program.checkInPolicy.biometricFallback}`)}</dd>
              </div>
              <div>
                <dt>{t('schedule.policy.geolocation')}</dt>
                <dd>{t(`schedule.policy.location.${program.checkInPolicy.geolocation}`)}</dd>
              </div>
            </dl>
            <p className="muted small">{t('settings.rules')}</p>
            {canDefaults ? (
              <details>
                <summary>{t('schedule.program.editDefaults')}</summary>
                <AttendanceDefaultsForm program={program} />
              </details>
            ) : (
              <p className="muted small">{t('settings.directorOnly')}</p>
            )}
          </section>
          <section className="card stack" aria-labelledby="visit-title">
            <h2 id="visit-title">{t('settings.perVisit')}</h2>
            <p className="muted">{t('settings.perVisitHint')}</p>
            <p>
              <Link href="/visits">{t('settings.openVisits')}</Link>
            </p>
          </section>
        </>
      )}
    </div>
  );
}
