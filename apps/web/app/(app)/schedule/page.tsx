import type { Metadata } from 'next';
import Link from 'next/link';
import {
  type Group,
  type ProgramState,
  type Schedule,
  type ScheduleException,
  type SettingsChange,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SettingsHistory } from '@/components/settings-history';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dateOfWeekday, dayValue, WEEK_ORDER } from '@/lib/calendar';
import {
  AttendanceDefaultsForm,
  CreateProgramForm,
  ExceptionForm,
  ProgramPlanForm,
  RemoveExceptionButton,
  ScheduleForm,
} from './schedule-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule'))('title') };
}

/**
 * Training schedule configuration (§6.1, §11): program settings, recurring
 * weekly schedules and days off. Each section appears only for the permissions
 * that may change it; the API enforces the same rules.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission(
    'schedule.manage',
    'schedule.group.manage',
    'attendance.settings.defaults',
  );
  const has = (p: (typeof user.permissions)[number]) => user.permissions.includes(p);
  const canPlan = has('schedule.manage');
  const canDefaults = has('attendance.settings.defaults');
  const canSchedules = canPlan || has('schedule.group.manage');
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const raw = await searchParams;

  const [programRes, schedulesRes, exceptionsRes, groupsRes, historyRes] = await Promise.all([
    apiFetch<ProgramState>('/program', { accessToken: token }),
    apiFetch<Schedule[]>('/schedules?includeEnded=true', { accessToken: token }),
    apiFetch<ScheduleException[]>('/schedule-exceptions', { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
    apiFetch<SettingsChange[]>('/program/history', { accessToken: token }),
  ]);
  const program = programRes.ok ? programRes.data.program : null;
  const schedules = schedulesRes.ok ? schedulesRes.data : [];
  const exceptions = exceptionsRes.ok ? exceptionsRes.data : [];
  const groups = groupsRes.ok ? groupsRes.data.map((g) => ({ id: g.id, name: g.name })) : [];
  const weekdayName = (w: number) =>
    format.dateTime(dayValue(dateOfWeekday(w)), { weekday: 'long' });
  const weekdayNames = WEEK_ORDER.map((day) => ({ day, label: weekdayName(day) }));
  const date = (d: string) => format.dateTime(dayValue(d), { dateStyle: 'medium' });
  const ended = typeof raw.ended === 'string' ? Number(raw.ended) : null;

  return (
    <div className="stack-lg">
      <h1>{t('schedule.title')}</h1>
      {ended !== null && (
        <p className="alert alert-success" role="status">
          {t('schedule.ended', { count: ended })}
        </p>
      )}

      {/* ── Program settings ── */}
      <section className="card stack" aria-labelledby="program-title">
        <h2 id="program-title">{t('schedule.program.title')}</h2>
        {!program ? (
          canPlan && canDefaults ? (
            <CreateProgramForm />
          ) : (
            <p className="alert alert-info">{t('schedule.program.missing')}</p>
          )
        ) : (
          <>
            <dl className="details">
              <div>
                <dt>{t('schedule.fields.name')}</dt>
                <dd>{program.name}</dd>
              </div>
              <div>
                <dt>{t('schedule.program.period')}</dt>
                <dd>
                  {t('schedule.program.periodValue', {
                    from: date(program.startDate),
                    to: date(program.endDate),
                    weeks: program.durationWeeks,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('schedule.fields.allowedAbsences')}</dt>
                <dd>{program.allowedAbsences}</dd>
              </div>
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
                <dt>{t('schedule.policy.title')}</dt>
                <dd>
                  {t('schedule.policy.summary', {
                    radius:
                      program.checkInPolicy.radiusMeters === null
                        ? t('schedule.policy.noLimit')
                        : t('schedule.policy.meters', {
                            meters: program.checkInPolicy.radiusMeters,
                          }),
                    accuracy:
                      program.checkInPolicy.maxAccuracyMeters === null
                        ? t('schedule.policy.noLimit')
                        : t('schedule.policy.meters', {
                            meters: program.checkInPolicy.maxAccuracyMeters,
                          }),
                  })}
                </dd>
              </div>
            </dl>
            {canPlan && (
              <details>
                <summary>{t('schedule.program.editPlan')}</summary>
                <ProgramPlanForm program={program} />
              </details>
            )}
            {canDefaults && (
              <details>
                <summary>{t('schedule.program.editDefaults')}</summary>
                <AttendanceDefaultsForm program={program} />
              </details>
            )}
          </>
        )}
      </section>

      {/* ── Weekly schedules ── */}
      {program && (
        <section className="card stack" aria-labelledby="schedules-title">
          <h2 id="schedules-title">{t('schedule.schedulesTitle')}</h2>
          {schedules.length === 0 ? (
            <p className="empty">{t('schedule.noSchedules')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('schedule.fields.title')}</th>
                    <th scope="col">{t('schedule.fields.weekdays')}</th>
                    <th scope="col">{t('visits.columns.time')}</th>
                    <th scope="col">{t('schedule.program.period')}</th>
                    <th scope="col">{t('schedule.fields.groups')}</th>
                    <th scope="col">{t('schedule.sessions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/schedule/${s.id}`}>{s.title}</Link>
                        {s.endedAt && (
                          <span className="status status-cancelled">
                            {' '}
                            {t('schedule.endedBadge')}
                          </span>
                        )}
                      </td>
                      <td>{format.list(s.weekdays.map(weekdayName))}</td>
                      <td dir="ltr">{s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime}</td>
                      <td>
                        {date(s.startsOn)} – {date(s.endsOn)}
                      </td>
                      <td>{format.list(s.groups.map((g) => g.name))}</td>
                      <td>
                        {t('schedule.sessionsValue', {
                          upcoming: s.upcomingCount,
                          total: s.visitCount,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canSchedules && (
            <details>
              <summary>{t('schedule.newSchedule')}</summary>
              <ScheduleForm groups={groups} weekdayNames={weekdayNames} program={program} />
            </details>
          )}
        </section>
      )}

      {/* ── Days off ── */}
      {program && (
        <section className="card stack" aria-labelledby="exceptions-title">
          <h2 id="exceptions-title">{t('schedule.exceptions.title')}</h2>
          <p className="muted small">{t('schedule.exceptions.hint')}</p>
          {exceptions.length === 0 ? (
            <p className="empty">{t('schedule.exceptions.none')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('schedule.fields.date')}</th>
                    <th scope="col">{t('schedule.exceptions.appliesTo')}</th>
                    <th scope="col">{t('schedule.fields.exceptionReason')}</th>
                    <th scope="col">{t('schedule.exceptions.cancelledSessions')}</th>
                    {canSchedules && (
                      <th scope="col">
                        <span className="sr-only">{t('common.actions')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((e) => (
                    <tr key={e.id}>
                      <td>{date(e.date)}</td>
                      <td>{e.schedule?.title ?? t('schedule.exceptions.allSchedules')}</td>
                      <td>{e.reason}</td>
                      <td>{e.cancelledVisits}</td>
                      {canSchedules && (
                        <td>
                          <RemoveExceptionButton id={e.id} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canSchedules && (
            <details>
              <summary>{t('schedule.exceptions.add')}</summary>
              <ExceptionForm
                allowAll={canPlan}
                schedules={schedules
                  .filter((s) => !s.endedAt)
                  .map((s) => ({ id: s.id, title: s.title }))}
              />
            </details>
          )}
        </section>
      )}

      {/* ── Configuration history (§11.3) ── */}
      {historyRes.ok && historyRes.data.length > 0 && (
        <section className="card stack" aria-labelledby="settings-history-title">
          <h2 id="settings-history-title">{t('schedule.history')}</h2>
          <SettingsHistory entries={historyRes.data} />
        </section>
      )}
    </div>
  );
}
