import type { Metadata } from 'next';
import Link from 'next/link';
import { type ListUsersResponse, ROLES } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('dashboard') };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();
  const canSeeAccounts = user.permissions.includes('users.read');
  // Real counts only — summary cards for visits/attendance arrive with their phases.
  const counts = canSeeAccounts ? await accountCounts(await accessToken()) : null;

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
