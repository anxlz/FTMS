import type { Metadata } from 'next';
import Link from 'next/link';
import { type Group } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { CreateGroupForm } from './group-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('groups'))('title') };
}

/** Training groups (§5). */
export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('students.read', 'groups.manage');
  const t = await getTranslations();
  const archived = (await searchParams).archived === 'true';
  const result = await apiFetch<Group[]>(`/groups${archived ? '?includeArchived=true' : ''}`, {
    accessToken: await accessToken(),
  });
  const canManage = user.permissions.includes('groups.manage');

  return (
    <div className="stack-lg">
      <h1>{t('groups.title')}</h1>

      {canManage && (
        <details className="card">
          <summary>
            <span className="h2">{t('groups.create')}</span>
          </summary>
          <CreateGroupForm />
        </details>
      )}

      <section className="card stack" aria-labelledby="groups-list">
        <div className="row-between">
          <h2 id="groups-list">{t('groups.listTitle')}</h2>
          <Link href={archived ? '/groups' : '/groups?archived=true'}>
            {archived ? t('groups.hideArchived') : t('groups.showArchived')}
          </Link>
        </div>
        {!result.ok ? (
          <p className="alert alert-error" role="alert">
            {t('errors.INTERNAL_ERROR')}
          </p>
        ) : result.data.length === 0 ? (
          <p className="empty">{t('groups.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('groups.name')}</th>
                  <th scope="col">{t('groups.members')}</th>
                  <th scope="col">{t('groups.description')}</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <Link href={`/groups/${g.id}`}>{g.name}</Link>
                      {g.archived && <span className="badge">{t('groups.archived')}</span>}
                    </td>
                    <td>{g.memberCount}</td>
                    <td>{g.description ?? t('common.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
