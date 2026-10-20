import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ACCOUNT_STATUSES, ListUsersQuerySchema, type ListUsersResponse, ROLES } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { CreateUserForm } from './create-user-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin'))('title') };
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user.permissions.includes('users.read')) notFound();
  const t = await getTranslations();
  const format = await getFormatter();

  const raw = await searchParams;
  const query = ListUsersQuerySchema.parse({
    q: typeof raw.q === 'string' && raw.q ? raw.q : undefined,
    role: typeof raw.role === 'string' && raw.role ? raw.role : undefined,
    status: typeof raw.status === 'string' && raw.status ? raw.status : undefined,
    page: typeof raw.page === 'string' ? raw.page : 1,
  });
  const params = new URLSearchParams(
    Object.entries({ ...query, pageSize: String(query.pageSize), page: String(query.page) }).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  const result = await apiFetch<ListUsersResponse>(`/admin/users?${params.toString()}`, {
    accessToken: await accessToken(),
  });
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    return `/admin/users?${next.toString()}`;
  };
  // Who may create which role — the API re-checks every request.
  const creatableRoles = user.permissions.includes('users.manage')
    ? [...ROLES]
    : user.permissions.includes('faculty.manage')
      ? (['FACULTY'] as const)
      : [];

  return (
    <div className="stack-lg">
      <h1>{t('admin.title')}</h1>

      {creatableRoles.length > 0 && (
        <details className="card">
          <summary>
            <span className="h2">{t('admin.create')}</span>
          </summary>
          <p className="muted small">{t('admin.createHint')}</p>
          <CreateUserForm roles={[...creatableRoles]} />
        </details>
      )}

      <section className="card stack" aria-labelledby="accounts-list">
        <h2 id="accounts-list" className="sr-only">
          {t('admin.title')}
        </h2>
        <form className="filters" role="search" method="get">
          <label className="sr-only" htmlFor="q">
            {t('common.search')}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query.q ?? ''}
            placeholder={t('admin.searchPlaceholder')}
          />
          <select name="role" defaultValue={query.role ?? ''} aria-label={t('admin.columns.role')}>
            <option value="">{t('admin.allRoles')}</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`roles.${role}`)}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={query.status ?? ''}
            aria-label={t('admin.columns.status')}
          >
            <option value="">{t('admin.allStatuses')}</option>
            {ACCOUNT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary">
            {t('common.search')}
          </button>
        </form>

        {!result.ok ? (
          <p className="alert alert-error" role="alert">
            {t.has(`errors.${result.code}`)
              ? t(`errors.${result.code}`, { minutes: 1 })
              : t('errors.INTERNAL_ERROR')}
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="empty">{t('admin.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('admin.columns.name')}</th>
                  <th scope="col">{t('admin.columns.email')}</th>
                  <th scope="col">{t('admin.columns.seatNumber')}</th>
                  <th scope="col">{t('admin.columns.role')}</th>
                  <th scope="col">{t('admin.columns.status')}</th>
                  <th scope="col">{t('admin.columns.password')}</th>
                  <th scope="col">{t('admin.columns.lastLogin')}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link href={`/admin/users/${u.id}`}>{u.displayName}</Link>
                    </td>
                    <td dir="ltr">{u.email}</td>
                    <td dir="ltr">{u.seatNumber ?? t('common.none')}</td>
                    <td>{t(`roles.${u.role}`)}</td>
                    <td>
                      <span className={`status status-${u.status.toLowerCase()}`}>
                        {t(`statuses.${u.status}`)}
                      </span>
                    </td>
                    <td>{u.hasPassword ? t('admin.passwordSet') : t('admin.passwordNotSet')}</td>
                    <td>
                      {u.lastLoginAt
                        ? format.dateTime(new Date(u.lastLoginAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : t('admin.never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result.ok && pages > 1 && (
          <nav className="pagination" aria-label={t('common.pageOf', { page: query.page, pages })}>
            {query.page > 1 && <Link href={pageHref(query.page - 1)}>{t('common.previous')}</Link>}
            <span>{t('common.pageOf', { page: query.page, pages })}</span>
            {query.page < pages && <Link href={pageHref(query.page + 1)}>{t('common.next')}</Link>}
          </nav>
        )}
      </section>
    </div>
  );
}
