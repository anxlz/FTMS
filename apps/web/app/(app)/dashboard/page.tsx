import type { Metadata } from 'next';
import Link from 'next/link';
import {
  addDays,
  type CalendarResponse,
  type Group,
  type ListProfileChangesResponse,
  type ListStudentsResponse,
  type ListUsersResponse,
  type ListVerificationsResponse,
  type MeResponse,
  type OwnStudentProfile,
  PROGRAM_TIME_ZONE,
  ROLES,
  todayIn,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';

const UPCOMING_DAYS = 14;

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
  // Real data only — attendance summaries arrive with Phase 4.
  const [counts, records, own, upcoming] = await Promise.all([
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
  ]);
  const nextVisits = upcoming.ok
    ? upcoming.data.visits.filter((v) => v.phase !== 'FINISHED').slice(0, 5)
    : [];

  return (
    <div className="stack-lg">
      <h1>{t('dashboard.welcome', { name: user.displayName })}</h1>

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
