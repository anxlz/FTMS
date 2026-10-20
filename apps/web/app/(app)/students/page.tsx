import type { Metadata } from 'next';
import Link from 'next/link';
import { type Group, ListStudentsQuerySchema, type ListStudentsResponse } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { CreateStudentForm } from './student-fields';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('students'))('title') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/** Student records (§4.1): search, filter, and the entry points to create and import. */
export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('students.read');
  const t = await getTranslations();
  const token = await accessToken();
  const raw = await searchParams;
  const parsed = ListStudentsQuerySchema.safeParse({
    q: param(raw, 'q'),
    group: param(raw, 'group'),
    account: param(raw, 'account'),
    page: param(raw, 'page') ?? 1,
  });
  const query = parsed.success ? parsed.data : ListStudentsQuerySchema.parse({});
  const params = new URLSearchParams(
    Object.entries({
      q: query.q,
      group: query.group,
      account: query.account,
      page: String(query.page),
      pageSize: String(query.pageSize),
    }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  );
  const [result, groups] = await Promise.all([
    apiFetch<ListStudentsResponse>(`/students?${params.toString()}`, { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    return `/students?${next.toString()}`;
  };
  const can = (p: (typeof user.permissions)[number]) => user.permissions.includes(p);

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1>{t('students.title')}</h1>
        {can('students.import') && (
          <Link className="btn btn-secondary" href="/students/import">
            {t('students.import')}
          </Link>
        )}
      </div>

      {can('students.manage') && (
        <details className="card">
          <summary>
            <span className="h2">{t('students.add')}</span>
          </summary>
          <p className="muted small">{t('students.addHint')}</p>
          <CreateStudentForm
            groups={
              can('groups.manage') && groups.ok ? groups.data.filter((g) => !g.archived) : null
            }
          />
        </details>
      )}

      <section className="card stack" aria-labelledby="students-list">
        <h2 id="students-list" className="sr-only">
          {t('students.title')}
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
            placeholder={t('students.searchPlaceholder')}
          />
          <select
            name="group"
            defaultValue={query.group ?? ''}
            aria-label={t('students.columns.group')}
          >
            <option value="">{t('students.allGroups')}</option>
            <option value="none">{t('students.noGroup')}</option>
            {groups.ok &&
              groups.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          <select
            name="account"
            defaultValue={query.account ?? ''}
            aria-label={t('students.columns.account')}
          >
            <option value="">{t('students.allAccounts')}</option>
            <option value="linked">{t('students.linked')}</option>
            <option value="unlinked">{t('students.unlinked')}</option>
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
          <p className="empty">{t('students.empty')}</p>
        ) : (
          <>
            <p className="muted small">{t('students.count', { total: result.data.total })}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('students.columns.seatNumber')}</th>
                    <th scope="col">{t('students.columns.name')}</th>
                    <th scope="col">{t('students.columns.group')}</th>
                    <th scope="col">{t('students.columns.email')}</th>
                    <th scope="col">{t('students.columns.account')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((s) => (
                    <tr key={s.id}>
                      <td dir="ltr">{s.seatNumber}</td>
                      <td>
                        <Link href={`/students/${s.id}`}>{s.fullName}</Link>
                      </td>
                      <td>{s.group?.name ?? t('students.noGroup')}</td>
                      <td dir="ltr">{s.universityEmail ?? t('common.none')}</td>
                      <td>
                        {s.account ? (
                          <span className={`status status-${s.account.status.toLowerCase()}`}>
                            {t(`statuses.${s.account.status}`)}
                          </span>
                        ) : (
                          <span className="muted">{t('students.notLinked')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
