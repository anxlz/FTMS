import type { Metadata } from 'next';
import Link from 'next/link';
import { type ProgramState, type SettingsChange } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SettingsHistory } from '@/components/settings-history';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
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
  const user = await requirePermission(
    'attendance.settings.visit',
    'attendance.settings.defaults',
    'audit.read',
  );
  const canDefaults = user.permissions.includes('attendance.settings.defaults');
  const canSchedule = user.permissions.includes('schedule.manage');
  const canAudit = user.permissions.includes('audit.read');
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const [res, history] = await Promise.all([
    apiFetch<ProgramState>('/program', { accessToken: token }),
    // Configuration history (§11.3) for those who manage the settings or read the audit log.
    canDefaults || canSchedule || canAudit
      ? apiFetch<SettingsChange[]>('/program/history', { accessToken: token })
      : null,
  ]);
  const program = res.ok ? res.data.program : null;
  const day = (d: string) => format.dateTime(dayValue(d), { dateStyle: 'medium' });

  return (
    <div className="stack-lg">
      <h1>{t('settings.title')}</h1>
      {!program ? (
        <p className="alert alert-info">{t('schedule.program.missing')}</p>
      ) : (
        <>
          <section className="card stack" aria-labelledby="program-title">
            <div className="row-between">
              <h2 id="program-title">{t('settings.program')}</h2>
              {canSchedule && <Link href="/schedule">{t('settings.editProgram')}</Link>}
            </div>
            <dl className="details">
              <div>
                <dt>{t('dashboard.programName')}</dt>
                <dd>{program.name}</dd>
              </div>
              <div>
                <dt>{t('dashboard.programPeriod')}</dt>
                <dd>
                  {day(program.startDate)} – {day(program.endDate)}
                </dd>
              </div>
              <div>
                <dt>{t('settings.duration')}</dt>
                <dd>{t('settings.weeks', { weeks: program.durationWeeks })}</dd>
              </div>
              <div>
                <dt>{t('settings.timeZone')}</dt>
                <dd dir="ltr">{program.timeZone}</dd>
              </div>
            </dl>
          </section>
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
          {history?.ok && (
            <section className="card stack" aria-labelledby="config-history-title">
              <div className="row-between">
                <h2 id="config-history-title">{t('settings.history')}</h2>
                {canAudit && (
                  <Link href="/audit?scope=all&resourceType=program">{t('settings.inAudit')}</Link>
                )}
              </div>
              {history.data.length === 0 ? (
                <p className="empty">{t('settings.noHistory')}</p>
              ) : (
                <SettingsHistory entries={history.data} />
              )}
            </section>
          )}
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
