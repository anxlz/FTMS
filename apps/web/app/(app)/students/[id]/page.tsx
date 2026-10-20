import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type Group, type StudentDetail } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { EditStudentForm } from '../student-fields';
import { DangerForm, GroupForm } from './student-actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('students'))('title') };
}

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('students.read');
  const { id } = await params;
  const token = await accessToken();
  const [result, groups] = await Promise.all([
    apiFetch<StudentDetail>(`/students/${encodeURIComponent(id)}`, { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  if (!result.ok) notFound();
  const s = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const can = (p: (typeof user.permissions)[number]) => user.permissions.includes(p);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <div className="stack-lg">
      <p>
        <Link href="/students">← {t('students.detail.back')}</Link>
      </p>
      <h1>{s.fullName}</h1>

      <section className="card" aria-labelledby="record-title">
        <h2 id="record-title">{t('students.detail.record')}</h2>
        <dl className="details">
          <div>
            <dt>{t('students.fields.seatNumber')}</dt>
            <dd dir="ltr">{s.seatNumber}</dd>
          </div>
          {(['firstName', 'fatherName', 'grandfatherName', 'familyName'] as const).map((key) => (
            <div key={key}>
              <dt>{t(`students.fields.${key}`)}</dt>
              <dd>{s[key] ?? t('common.none')}</dd>
            </div>
          ))}
          <div>
            <dt>{t('students.fields.universityEmail')}</dt>
            <dd dir="ltr">{s.universityEmail ?? t('common.none')}</dd>
          </div>
          <div>
            <dt>{t('students.fields.phone')}</dt>
            <dd dir="ltr">{s.phone ?? t('common.none')}</dd>
          </div>
          <div>
            <dt>{t('students.fields.group')}</dt>
            <dd>{s.group?.name ?? t('students.noGroup')}</dd>
          </div>
        </dl>
        {s.pendingProfileChangeId && (
          <p className="alert alert-info">
            {t('students.detail.pendingChange')}{' '}
            {can('profile_changes.decide') && (
              <Link href={`/reviews/profile-changes/${s.pendingProfileChangeId}`}>
                {t('students.detail.review')}
              </Link>
            )}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="account-title">
        <h2 id="account-title">{t('students.detail.account')}</h2>
        {s.account ? (
          <dl className="details">
            <div>
              <dt>{t('dashboard.email')}</dt>
              <dd dir="ltr">{s.account.email}</dd>
            </div>
            <div>
              <dt>{t('dashboard.status')}</dt>
              <dd>
                <span className={`status status-${s.account.status.toLowerCase()}`}>
                  {t(`statuses.${s.account.status}`)}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t('admin.columns.password')}</dt>
              <dd>{s.account.hasPassword ? t('admin.passwordSet') : t('admin.passwordNotSet')}</dd>
            </div>
            <div>
              <dt>{t('admin.columns.lastLogin')}</dt>
              <dd>
                {s.account.lastLoginAt
                  ? format.dateTime(new Date(s.account.lastLoginAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : t('admin.never')}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="muted">{t('students.detail.accountNone')}</p>
        )}
      </section>

      {can('students.manage') && (
        <section className="card" aria-labelledby="edit-title">
          <h2 id="edit-title">{t('students.detail.edit')}</h2>
          {s.firstName === null && (
            <p className="muted small">{t('students.detail.fullNameOnly', { name: s.fullName })}</p>
          )}
          <EditStudentForm
            id={s.id}
            emailLocked={s.account !== null}
            initial={{
              seatNumber: s.seatNumber,
              firstName: s.firstName,
              fatherName: s.fatherName,
              grandfatherName: s.grandfatherName,
              familyName: s.familyName,
              universityEmail: s.universityEmail,
              phone: s.phone,
            }}
          />
        </section>
      )}

      {can('groups.manage') && groups.ok && (
        <section className="card" aria-labelledby="group-title">
          <h2 id="group-title">{t('students.detail.groupTitle')}</h2>
          <GroupForm
            id={s.id}
            current={s.group?.id ?? null}
            groups={groups.data.filter((g) => !g.archived)}
          />
        </section>
      )}

      <section className="card" aria-labelledby="history-title">
        <h2 id="history-title">{t('students.detail.history')}</h2>
        {s.memberships.length === 0 ? (
          <p className="empty">{t('students.detail.historyEmpty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('students.fields.group')}</th>
                  <th scope="col">{t('students.detail.from')}</th>
                  <th scope="col">{t('students.detail.until')}</th>
                  <th scope="col">{t('students.detail.source')}</th>
                </tr>
              </thead>
              <tbody>
                {s.memberships.map((m) => (
                  <tr key={`${m.group.id}-${m.startedAt}`}>
                    <td>{m.group.name}</td>
                    <td>{date(m.startedAt)}</td>
                    <td>{m.endedAt ? date(m.endedAt) : t('students.detail.current')}</td>
                    <td>{t(`students.sources.${m.source}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {can('students.manage') && (
        <section className="card danger-zone stack" aria-labelledby="danger-title">
          <h2 id="danger-title">
            {s.account ? t('students.detail.unlinkTitle') : t('students.detail.deleteTitle')}
          </h2>
          <DangerForm id={s.id} kind={s.account ? 'unlink' : 'delete'} />
        </section>
      )}
    </div>
  );
}
