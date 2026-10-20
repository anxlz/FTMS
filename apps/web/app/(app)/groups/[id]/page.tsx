import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type GroupDetail, type ListStudentsResponse } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { AddMembersForm, ArchiveForm, EditGroupForm, RemoveMemberButton } from '../group-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('groups'))('title') };
}

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('students.read', 'groups.manage');
  const { id } = await params;
  const token = await accessToken();
  const result = await apiFetch<GroupDetail>(`/groups/${encodeURIComponent(id)}`, {
    accessToken: token,
  });
  if (!result.ok) notFound();
  const g = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const canManage = user.permissions.includes('groups.manage') && !g.archived;
  const canSeeStudents = user.permissions.includes('students.read');

  // Candidates to add: a search (or students without a group), excluding current members.
  const raw = await searchParams;
  const q = typeof raw.q === 'string' ? raw.q.trim() : '';
  const candidates =
    canManage && canSeeStudents
      ? await apiFetch<ListStudentsResponse>(
          `/students?pageSize=50&${q ? `q=${encodeURIComponent(q)}` : 'group=none'}`,
          { accessToken: token },
        )
      : null;
  const memberIds = new Set(g.members.map((m) => m.studentId));

  return (
    <div className="stack-lg">
      <p>
        <Link href="/groups">← {t('groups.detail.back')}</Link>
      </p>
      <div className="row-between">
        <h1>{g.name}</h1>
        {g.archived && <span className="badge">{t('groups.archived')}</span>}
      </div>
      {g.description && <p className="muted">{g.description}</p>}

      <section className="card stack" aria-labelledby="members-title">
        <h2 id="members-title">
          {t('groups.detail.membersTitle')} ({g.memberCount})
        </h2>
        {g.members.length === 0 ? (
          <p className="empty">{t('groups.detail.noMembers')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('students.columns.seatNumber')}</th>
                  <th scope="col">{t('students.columns.name')}</th>
                  <th scope="col">{t('groups.detail.since')}</th>
                  <th scope="col">{t('students.columns.account')}</th>
                  {canManage && (
                    <th scope="col">
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {g.members.map((m) => (
                  <tr key={m.studentId}>
                    <td dir="ltr">{m.seatNumber}</td>
                    <td>
                      {canSeeStudents ? (
                        <Link href={`/students/${m.studentId}`}>{m.fullName}</Link>
                      ) : (
                        m.fullName
                      )}
                    </td>
                    <td>{format.dateTime(new Date(m.since), { dateStyle: 'medium' })}</td>
                    <td>{m.hasAccount ? t('students.linked') : t('students.notLinked')}</td>
                    {canManage && (
                      <td>
                        <RemoveMemberButton id={g.id} studentId={m.studentId} name={m.fullName} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && candidates && (
        <section className="card stack" aria-labelledby="add-title">
          <h2 id="add-title">{t('groups.detail.addTitle')}</h2>
          <form className="filters" role="search" method="get">
            <label className="sr-only" htmlFor="candidate-q">
              {t('common.search')}
            </label>
            <input
              id="candidate-q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder={t('students.searchPlaceholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('common.search')}
            </button>
          </form>
          <p className="muted small">
            {q ? t('groups.detail.searchResults') : t('groups.detail.ungroupedHint')}
          </p>
          {candidates.ok ? (
            <AddMembersForm
              id={g.id}
              candidates={candidates.data.items.filter((s) => !memberIds.has(s.id))}
            />
          ) : (
            <p className="alert alert-error">{t('errors.INTERNAL_ERROR')}</p>
          )}
        </section>
      )}

      {user.permissions.includes('groups.manage') && (
        <>
          {!g.archived && (
            <section className="card" aria-labelledby="edit-title">
              <h2 id="edit-title">{t('groups.detail.edit')}</h2>
              <EditGroupForm id={g.id} name={g.name} description={g.description} />
            </section>
          )}
          <section className="card" aria-labelledby="archive-title">
            <h2 id="archive-title">
              {g.archived ? t('groups.detail.restore') : t('groups.detail.archive')}
            </h2>
            <ArchiveForm id={g.id} archived={g.archived} />
          </section>
        </>
      )}
    </div>
  );
}
