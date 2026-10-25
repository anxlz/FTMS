import type { Metadata } from 'next';
import Link from 'next/link';
import {
  addDays,
  type AttendanceOverview,
  type CalendarResponse,
  type FacultyActivityResponse,
  type Group,
  type GroupSwapView,
  type ListAuditLogsResponse,
  type ListGroupSwapsResponse,
  type ListProfileChangesResponse,
  type ListStudentsResponse,
  type ListTicketsResponse,
  type ListUsersResponse,
  type ListVerificationsResponse,
  type MeResponse,
  type OwnAttendanceResponse,
  type OwnStudentProfile,
  type ProgramState,
  PROGRAM_TIME_ZONE,
  ROLES,
  todayIn,
  type UnreadCount,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AppCheckIn } from '@/components/app-check-in';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';

const UPCOMING_DAYS = 14;
/** The Training Director's activity card covers this many days up to today. */
const ACTIVITY_DAYS = 7;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('dashboard') };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();
  const token = await accessToken();
  const has = (p: MeResponse['permissions'][number]) => user.permissions.includes(p);
  const format = await getFormatter();
  const today = todayIn(PROGRAM_TIME_ZONE);
  // Real data only: every figure comes from the API.
  const canAudit = has('audit.read');
  const canSettings = has('schedule.manage') || has('attendance.settings.defaults');
  const [
    counts,
    records,
    own,
    upcoming,
    attendance,
    overview,
    requests,
    activity,
    recent,
    program,
  ] = await Promise.all([
    has('users.read') ? accountCounts(token) : null,
    has('students.read')
      ? studentCounts(token, has('profile_changes.decide'), has('students.manage'))
      : null,
    user.role === 'STUDENT'
      ? apiFetch<OwnStudentProfile>('/me/student', { accessToken: token })
      : null,
    apiFetch<CalendarResponse>(
      `/calendar?from=${today}&to=${addDays(today, UPCOMING_DAYS)}&status=SCHEDULED`,
      { accessToken: token },
    ),
    user.role === 'STUDENT'
      ? apiFetch<OwnAttendanceResponse>('/me/attendance', { accessToken: token })
      : null,
    has('attendance.read')
      ? apiFetch<AttendanceOverview>('/attendance/overview', { accessToken: token })
      : null,
    requestCounts(token, {
      student: user.role === 'STUDENT',
      tickets: has('tickets.process'),
      swaps: has('group_swaps.decide'),
    }),
    canAudit
      ? apiFetch<FacultyActivityResponse>(
          `/audit-logs/activity?from=${addDays(today, -(ACTIVITY_DAYS - 1))}&to=${today}`,
          { accessToken: token },
        )
      : null,
    canAudit
      ? apiFetch<ListAuditLogsResponse>('/audit-logs?scope=staff&pageSize=6', {
          accessToken: token,
        })
      : null,
    canSettings ? apiFetch<ProgramState>('/program', { accessToken: token }) : null,
  ]);
  const summary = attendance?.ok ? attendance.data.summary : null;
  const staffActivity = activity?.ok ? activity.data : null;
  const settings = program?.ok ? program.data.program : null;
  const programWeek = settings
    ? Math.min(
        settings.durationWeeks,
        Math.max(
          0,
          Math.floor((Date.parse(today) - Date.parse(settings.startDate)) / 604_800_000) + 1,
        ),
      )
    : null;
  const totals = overview?.ok ? overview.data : null;
  const nextVisits = upcoming.ok
    ? upcoming.data.visits.filter((v) => v.phase !== 'FINISHED').slice(0, 5)
    : [];

  return (
    <div className="stack-lg">
      <h1>{t('dashboard.welcome', { name: user.displayName })}</h1>
      {user.role === 'STUDENT' && <AppCheckIn />}

      <section className="card" aria-labelledby="account-title">
        <h2 id="account-title">{t('dashboard.account')}</h2>
        <dl className="details">
          <div>
            <dt>{t('dashboard.email')}</dt>
            <dd dir="ltr">{user.email}</dd>
          </div>
          {user.studentProfile && (
            <div>
              <dt>{t('dashboard.seatNumber')}</dt>
              <dd dir="ltr">{user.studentProfile.seatNumber}</dd>
            </div>
          )}
          {own?.ok && (
            <div>
              <dt>{t('dashboard.group')}</dt>
              <dd>{own.data.group?.name ?? t('dashboard.noGroup')}</dd>
            </div>
          )}
          <div>
            <dt>{t('dashboard.role')}</dt>
            <dd>{t(`roles.${user.role}`)}</dd>
          </div>
          <div>
            <dt>{t('dashboard.status')}</dt>
            <dd>{t(`statuses.${user.status}`)}</dd>
          </div>
        </dl>
      </section>

      {summary && (
        <section className="card stack" aria-labelledby="attendance-title">
          <div className="row-between">
            <h2 id="attendance-title">{t('dashboard.attendanceTitle')}</h2>
            <Link href="/attendance">{t('dashboard.openAttendance')}</Link>
          </div>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{summary.attended}</span>
              <span className="stat-label">{t('attendance.attended')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.present}</span>
              <span className="stat-label">{t('attendance.presentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.late}</span>
              <span className="stat-label">{t('attendance.lateCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{summary.absent}</span>
              <span className="stat-label">{t('attendance.absentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">
                {summary.remainingAbsences}
                <span className="stat-of"> / {summary.allowedAbsences}</span>
              </span>
              <span className="stat-label">{t('attendance.remainingAbsences')}</span>
            </li>
          </ul>
          {summary.absent > summary.allowedAbsences && (
            <p className="alert alert-error">{t('attendance.overAllowance')}</p>
          )}
        </section>
      )}

      {totals && (
        <section className="card stack" aria-labelledby="overview-title">
          <div className="row-between">
            <h2 id="overview-title">{t('dashboard.overviewTitle')}</h2>
            <Link href="/attendance">{t('dashboard.openAttendance')}</Link>
          </div>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{totals.visits.completed}</span>
              <span className="stat-label">
                {t('attendance.completedOf', { total: totals.visits.total })}
              </span>
            </li>
            <li className="stat">
              <span className="stat-value">{totals.visits.nextSevenDays}</span>
              <span className="stat-label">{t('attendance.nextSevenDays')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{totals.records.present}</span>
              <span className="stat-label">{t('attendance.presentCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{totals.records.late}</span>
              <span className="stat-label">{t('attendance.lateCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{totals.records.absent}</span>
              <span className="stat-label">{t('attendance.absentCount')}</span>
            </li>
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="requests-title">
        <div className="row-between">
          <h2 id="requests-title">{t('dashboard.requestsTitle')}</h2>
          {(user.role === 'STUDENT' || has('tickets.process')) && (
            <Link href="/tickets">{t('dashboard.openTickets')}</Link>
          )}
        </div>
        <ul className="stat-grid">
          {requests.activeTickets !== null && (
            <li className="stat">
              <span className="stat-value">{requests.activeTickets ?? '—'}</span>
              <span className="stat-label">
                <Link href="/tickets?status=ACTIVE">{t('dashboard.activeTickets')}</Link>
              </span>
            </li>
          )}
          {requests.swapsForMe !== null && (
            <li className="stat">
              <span className="stat-value">{requests.swapsForMe ?? '—'}</span>
              <span className="stat-label">
                <Link href="/tickets">{t('dashboard.swapsForMe')}</Link>
              </span>
            </li>
          )}
          {requests.swapsForFaculty !== null && (
            <li className="stat">
              <span className="stat-value">{requests.swapsForFaculty ?? '—'}</span>
              <span className="stat-label">
                <Link href="/group-swaps">{t('dashboard.swapsForFaculty')}</Link>
              </span>
            </li>
          )}
          <li className="stat">
            <span className="stat-value">{requests.unread ?? '—'}</span>
            <span className="stat-label">
              <Link href="/notifications">{t('dashboard.unreadNotifications')}</Link>
            </span>
          </li>
        </ul>
      </section>

      {staffActivity && (
        <section className="card stack" aria-labelledby="staff-activity-title">
          <div className="row-between">
            <h2 id="staff-activity-title">
              {t('dashboard.staffActivityTitle', { days: ACTIVITY_DAYS })}
            </h2>
            <Link href="/audit/activity">{t('dashboard.openActivity')}</Link>
          </div>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{staffActivity.totals.actions}</span>
              <span className="stat-label">{t('audit.actionsCount')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{staffActivity.totals.decisions}</span>
              <span className="stat-label">
                <Link href="/audit?decisions=true&scope=all">{t('audit.decisionsCount')}</Link>
              </span>
            </li>
            <li className="stat">
              <span className="stat-value">{staffActivity.totals.failures}</span>
              <span className="stat-label">
                <Link href="/audit?outcome=FAILURE&scope=staff">{t('audit.failuresCount')}</Link>
              </span>
            </li>
            <li className="stat">
              <span className="stat-value">
                {staffActivity.totals.activeStaff}
                <span className="stat-of"> / {staffActivity.rows.length}</span>
              </span>
              <span className="stat-label">{t('audit.activeStaff')}</span>
            </li>
          </ul>
          {recent?.ok && recent.data.items.length > 0 && (
            <>
              <h3 className="h3">{t('dashboard.recentStaffActions')}</h3>
              <ul className="agenda">
                {recent.data.items.map((e) => (
                  <li key={e.id}>
                    <Link href={`/audit/${e.id}`}>
                      <strong>{t(`audit.actions.${e.action}`)}</strong>
                    </Link>
                    <p className="muted small">
                      {e.actor?.name ?? t('audit.system')} ·{' '}
                      {format.dateTime(new Date(e.at), { dateStyle: 'medium', timeStyle: 'short' })}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small">
            <Link href="/audit">{t('dashboard.openAudit')}</Link>
          </p>
        </section>
      )}

      {settings && (
        <section className="card stack" aria-labelledby="program-title">
          <div className="row-between">
            <h2 id="program-title">{t('dashboard.programTitle')}</h2>
            <Link href="/settings">{t('dashboard.openSettings')}</Link>
          </div>
          <dl className="details">
            <div>
              <dt>{t('dashboard.programName')}</dt>
              <dd>{settings.name}</dd>
            </div>
            <div>
              <dt>{t('dashboard.programPeriod')}</dt>
              <dd>
                {format.dateTime(dayValue(settings.startDate), { dateStyle: 'medium' })} –{' '}
                {format.dateTime(dayValue(settings.endDate), { dateStyle: 'medium' })}
              </dd>
            </div>
            <div>
              <dt>{t('dashboard.programWeek')}</dt>
              <dd>
                {t('dashboard.weekOf', { week: programWeek ?? 0, weeks: settings.durationWeeks })}
              </dd>
            </div>
            <div>
              <dt>{t('schedule.program.timing')}</dt>
              <dd>
                {t('visits.fields.timingFixed', {
                  opens: settings.timing.checkInOpensMinutes,
                  grace: settings.timing.graceMinutes,
                  closes: settings.timing.checkInClosesMinutes,
                })}
              </dd>
            </div>
            <div>
              <dt>{t('schedule.fields.allowedAbsences')}</dt>
              <dd>{settings.allowedAbsences}</dd>
            </div>
          </dl>
        </section>
      )}

      {upcoming.ok && (
        <section className="card stack" aria-labelledby="upcoming-title">
          <div className="row-between">
            <h2 id="upcoming-title">{t('dashboard.upcomingTitle', { days: UPCOMING_DAYS })}</h2>
            <Link href="/calendar">{t('dashboard.openCalendar')}</Link>
          </div>
          {nextVisits.length === 0 ? (
            <p className="empty">{t('dashboard.noUpcoming')}</p>
          ) : (
            <ul className="agenda">
              {nextVisits.map((v) => (
                <li key={v.id}>
                  <Link href={`/visits/${v.id}`}>
                    <strong>{v.title}</strong>
                  </Link>
                  <p className="muted small">
                    {format.dateTime(dayValue(v.date), { dateStyle: 'full' })} ·{' '}
                    <span dir="ltr">{timeRange(v)}</span>
                    {v.locationName ? ` · ${v.locationName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {records && (
        <section className="card" aria-labelledby="students-title">
          <div className="row-between">
            <h2 id="students-title">{t('dashboard.studentsTitle')}</h2>
            <Link href="/students">{t('dashboard.manageStudents')}</Link>
          </div>
          <ul className="stat-grid">
            <li className="stat">
              <span className="stat-value">{records.total ?? '—'}</span>
              <span className="stat-label">{t('dashboard.studentsTotal')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{records.unlinked ?? '—'}</span>
              <span className="stat-label">{t('dashboard.studentsUnlinked')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{records.ungrouped ?? '—'}</span>
              <span className="stat-label">{t('dashboard.studentsUngrouped')}</span>
            </li>
            <li className="stat">
              <span className="stat-value">{records.groups ?? '—'}</span>
              <span className="stat-label">{t('dashboard.groups')}</span>
            </li>
            {records.pendingChanges !== null && (
              <li className="stat">
                <span className="stat-value">{records.pendingChanges ?? '—'}</span>
                <span className="stat-label">
                  <Link href="/reviews">{t('dashboard.pendingChanges')}</Link>
                </span>
              </li>
            )}
            {records.pendingVerifications !== null && (
              <li className="stat">
                <span className="stat-value">{records.pendingVerifications ?? '—'}</span>
                <span className="stat-label">
                  <Link href="/reviews">{t('dashboard.pendingVerifications')}</Link>
                </span>
              </li>
            )}
          </ul>
        </section>
      )}

      {counts && (
        <section className="card" aria-labelledby="accounts-title">
          <div className="row-between">
            <h2 id="accounts-title">{t('dashboard.accountsTitle')}</h2>
            <Link href="/admin/users">{t('dashboard.manageAccounts')}</Link>
          </div>
          <p className="muted small">{t('dashboard.accountsHint')}</p>
          <ul className="stat-grid">
            {ROLES.map((role) => (
              <li key={role} className="stat">
                <span className="stat-value">{counts[role] ?? '—'}</span>
                <span className="stat-label">{t(`roles.${role}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="alert alert-info">
        {user.role === 'STUDENT' ? t('dashboard.studentNote') : t('dashboard.facultyNote')}
      </p>
    </div>
  );
}

/** Number of accounts per role, from the API (no hardcoded figures). */
async function accountCounts(
  token: string | null,
): Promise<Partial<Record<(typeof ROLES)[number], number>>> {
  const entries = await Promise.all(
    ROLES.map(async (role) => {
      const res = await apiFetch<ListUsersResponse>(`/admin/users?role=${role}&pageSize=1`, {
        accessToken: token,
      });
      return [role, res.ok ? res.data.total : undefined] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, n]) => n !== undefined));
}

/** Student-record figures from the API; `null` where the account may not see them. */
async function studentCounts(token: string | null, canChanges: boolean, canVerify: boolean) {
  const total = (query: string) =>
    apiFetch<ListStudentsResponse>(`/students?pageSize=1${query}`, { accessToken: token }).then(
      (r) => (r.ok ? r.data.total : undefined),
    );
  const [all, unlinked, ungrouped, groups, pendingChanges, pendingVerifications] =
    await Promise.all([
      total(''),
      total('&account=unlinked'),
      total('&group=none'),
      apiFetch<Group[]>('/groups', { accessToken: token }).then((r) =>
        r.ok ? r.data.length : undefined,
      ),
      canChanges
        ? apiFetch<ListProfileChangesResponse>('/profile-changes?status=PENDING&pageSize=1', {
            accessToken: token,
          }).then((r) => (r.ok ? r.data.total : undefined))
        : null,
      canVerify
        ? apiFetch<ListVerificationsResponse>('/student-verifications?status=PENDING&pageSize=1', {
            accessToken: token,
          }).then((r) => (r.ok ? r.data.total : undefined))
        : null,
    ]);
  return { total: all, unlinked, ungrouped, groups, pendingChanges, pendingVerifications };
}

/**
 * Tickets and requests that need someone (§13, §14), from the API; `null`
 * where the account has no such queue, `undefined` if it could not be read.
 */
async function requestCounts(
  token: string | null,
  can: { student: boolean; tickets: boolean; swaps: boolean },
) {
  const total = <T extends { total: number }>(path: string) =>
    apiFetch<T>(path, { accessToken: token }).then((r) => (r.ok ? r.data.total : undefined));
  const [activeTickets, swapsForMe, swapsForFaculty, unread] = await Promise.all([
    can.student
      ? total<ListTicketsResponse>('/me/tickets?status=ACTIVE&pageSize=1')
      : can.tickets
        ? total<ListTicketsResponse>('/tickets?status=ACTIVE&pageSize=1')
        : null,
    can.student
      ? apiFetch<GroupSwapView[]>('/me/group-swaps', { accessToken: token }).then((r) =>
          r.ok
            ? r.data.filter((s) => s.role === 'COUNTERPART' && s.status === 'PENDING_COUNTERPART')
                .length
            : undefined,
        )
      : null,
    can.swaps
      ? total<ListGroupSwapsResponse>('/group-swaps?status=PENDING_FACULTY&pageSize=1')
      : null,
    apiFetch<UnreadCount>('/notifications/unread-count', { accessToken: token }).then((r) =>
      r.ok ? r.data.unread : undefined,
    ),
  ]);
  return { activeTickets, swapsForMe, swapsForFaculty, unread };
}
