import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  addDays,
  type AttendanceOverview,
  type CalendarResponse,
  type Group,
  type OwnAttendanceResponse,
  PROGRAM_TIME_ZONE,
  todayIn,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AttendanceBadge } from '@/components/attendance-badge';
import { ExportForm } from '@/components/export-form';
import { timeRange, VisitStatus } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('attendance'))('title') };
}

/** Past days of visits listed for faculty (the calendar API allows 100 days at most). */
const LOOKBACK_DAYS = 60;

/**
 * Attendance: a student's own summary and history (§9.1–9.3), or the
 * training-wide figures, the visits to open and the report export for staff
 * (§10.1, §10.3, §10.4). Every figure comes from the API.
 */
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const raw = await searchParams;
  const exportError = typeof raw.exportError === 'string' ? raw.exportError : null;
  if (user.role === 'STUDENT') return <StudentAttendance />;
  if (!user.permissions.includes('attendance.read')) notFound();
  return (
    <StaffAttendance
      canExport={user.permissions.includes('reports.export')}
      exportError={exportError}
    />
  );
}

async function StudentAttendance() {
  const t = await getTranslations('attendance');
  const format = await getFormatter();
  const res = await apiFetch<OwnAttendanceResponse>('/me/attendance', {
    accessToken: await accessToken(),
  });
  if (!res.ok) {
    return (
      <div className="stack-lg">
        <h1>{t('title')}</h1>
        <p className="alert alert-error">{t('loadFailed')}</p>
      </div>
    );
  }
  const { summary, records } = res.data;
  const over = summary !== null && summary.absent > summary.allowedAbsences;
  return (
    <div className="stack-lg">
      <h1>{t('title')}</h1>
      {summary ? (
        <section className="card stack" aria-labelledby="summary-title">
          <h2 id="summary-title">{t('summary')}</h2>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{summary.attended}</span>
              <span className="stat-label">{t('attended')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.present}</span>
              <span className="stat-label">{t('presentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.late}</span>
              <span className="stat-label">{t('lateCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.absent}</span>
              <span className="stat-label">{t('absentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">
                {summary.remainingAbsences}
                <span className="stat-of"> / {summary.allowedAbsences}</span>
              </span>
              <span className="stat-label">{t('remainingAbsences')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.upcomingVisits}</span>
              <span className="stat-label">
                {t('upcomingOf', { total: summary.scheduledVisits })}
              </span>
            </li>
          </ul>
          {over && <p className="alert alert-error">{t('overAllowance')}</p>}
        </section>
      ) : (
        <p className="alert alert-info">{t('noProgram')}</p>
      )}

      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">{t('history')}</h2>
        {records.length === 0 ? (
          <p className="empty">{t('noRecords')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('columns.date')}</th>
                  <th scope="col">{t('columns.visit')}</th>
                  <th scope="col">{t('columns.status')}</th>
                  <th scope="col">{t('columns.checkIn')}</th>
                  <th scope="col">{t('columns.source')}</th>
                  <th scope="col">{t('columns.note')}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.visit.id}>
                    <td>
                      {format.dateTime(dayValue(r.visit.date), { dateStyle: 'medium' })}
                      <br />
                      <span className="muted small" dir="ltr">
                        {timeRange(r.visit)}
                      </span>
                    </td>
                    <td>
                      <Link href={`/visits/${r.visit.id}`}>{r.visit.title}</Link>
                    </td>
                    <td>
                      <AttendanceBadge status={r.status} minutesLate={r.minutesLate} />
                    </td>
                    <td>
                      {r.checkedInAt
                        ? format.dateTime(new Date(r.checkedInAt), { timeStyle: 'short' })
                        : t('noCheckIn')}
                    </td>
                    <td>{t(`source.${r.source}`)}</td>
                    <td>{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('rulesNote')}</p>
      </section>
    </div>
  );
}

async function StaffAttendance({
  canExport,
  exportError,
}: {
  canExport: boolean;
  exportError: string | null;
}) {
  const t = await getTranslations('attendance');
  const format = await getFormatter();
  const token = await accessToken();
  const today = todayIn(PROGRAM_TIME_ZONE);
  const [overviewRes, calendarRes, groupsRes] = await Promise.all([
    apiFetch<AttendanceOverview>('/attendance/overview', { accessToken: token }),
    apiFetch<CalendarResponse>(
      `/calendar?from=${addDays(today, -LOOKBACK_DAYS)}&to=${addDays(today, 7)}&status=SCHEDULED`,
      { accessToken: token },
    ),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  const overview = overviewRes.ok ? overviewRes.data : null;
  const visits = calendarRes.ok
    ? [...calendarRes.data.visits].sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    : [];
  const groups = groupsRes.ok ? groupsRes.data.map((g) => ({ id: g.id, name: g.name })) : [];

  return (
    <div className="stack-lg">
      <h1>{t('staffTitle')}</h1>
      {overview && (
        <section className="card stack" aria-labelledby="overview-title">
          <h2 id="overview-title">{t('overview')}</h2>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{overview.visits.completed}</span>
              <span className="stat-label">
                {t('completedOf', { total: overview.visits.total })}
              </span>
            </li>
            <li className="stat">
              <span className="stat-value">{overview.visits.remaining}</span>
              <span className="stat-label">{t('remainingVisits')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{overview.visits.nextSevenDays}</span>
              <span className="stat-label">{t('nextSevenDays')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{overview.records.present}</span>
              <span className="stat-label">{t('presentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{overview.records.late}</span>
              <span className="stat-label">{t('lateCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{overview.records.absent}</span>
              <span className="stat-label">{t('absentCount')}</span>
            </li>
          </ul>
          {overview.groups.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('columns.group')}</th>
                    <th scope="col">{t('completedVisits')}</th>
                    <th scope="col">{t('status.PRESENT')}</th>
                    <th scope="col">{t('status.LATE')}</th>
                    <th scope="col">{t('status.ABSENT')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.groups.map((g) => (
                    <tr key={g.group.id}>
                      <th scope="row">{g.group.name}</th>
                      <td>{g.completedVisits}</td>
                      <td>{g.present}</td>
                      <td>{g.late}</td>
                      <td>{g.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="visits-title">
        <h2 id="visits-title">{t('visitsTitle', { days: LOOKBACK_DAYS })}</h2>
        {visits.length === 0 ? (
          <p className="empty">{t('noVisits')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('columns.date')}</th>
                  <th scope="col">{t('columns.visit')}</th>
                  <th scope="col">{t('columns.groups')}</th>
                  <th scope="col">{t('columns.state')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {format.dateTime(dayValue(v.date), { dateStyle: 'medium' })}
                      <br />
                      <span className="muted small" dir="ltr">
                        {timeRange(v)}
                      </span>
                    </td>
                    <td>{v.title}</td>
                    <td>{format.list(v.groups.map((g) => g.name))}</td>
                    <td>
                      <VisitStatus visit={v} />
                    </td>
                    <td>
                      <Link href={`/visits/${v.id}/attendance`}>{t('open')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canExport && (
        <section className="card stack" aria-labelledby="export-title">
          <h2 id="export-title">{t('export.title')}</h2>
          <ExportForm groups={groups} back="/attendance" error={exportError} />
        </section>
      )}
    </div>
  );
}
