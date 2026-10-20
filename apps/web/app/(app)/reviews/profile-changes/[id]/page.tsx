import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type ProfileChangeReview } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { DecisionForms } from '../../review-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reviews'))('profileChange.title') };
}

export default async function ProfileChangePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('profile_changes.decide');
  const { id } = await params;
  const result = await apiFetch<ProfileChangeReview>(`/profile-changes/${encodeURIComponent(id)}`, {
    accessToken: await accessToken(),
  });
  if (!result.ok) notFound();
  const c = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack-lg">
      <p>
        <Link href="/reviews">← {t('reviews.back')}</Link>
      </p>
      <div className="row-between">
        <h1>{t('reviews.profileChange.title')}</h1>
        <span className={`status status-${c.status.toLowerCase()}`}>
          {t(`reviews.statuses.${c.status}`)}
        </span>
      </div>

      <section className="card stack" aria-labelledby="student-title">
        <h2 id="student-title">{t('reviews.profileChange.student')}</h2>
        <p>
          {user.permissions.includes('students.read') ? (
            <Link href={`/students/${c.student.id}`}>{c.student.fullName}</Link>
          ) : (
            c.student.fullName
          )}{' '}
          <span className="muted" dir="ltr">
            {c.student.seatNumber}
          </span>
        </p>
        <p className="muted small">
          {t('reviews.profileChange.submittedOn', { date: date(c.createdAt) })}
        </p>
        <blockquote className="alert alert-info">
          <strong>{t('reviews.profileChange.note')}:</strong> {c.note}
        </blockquote>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('reviews.profileChange.field')}</th>
                <th scope="col">
                  {c.status === 'PENDING'
                    ? t('reviews.profileChange.now')
                    : t('reviews.profileChange.was')}
                </th>
                <th scope="col">{t('reviews.profileChange.requested')}</th>
              </tr>
            </thead>
            <tbody>
              {c.changes.map((ch) => (
                <tr key={ch.field}>
                  <th scope="row">{t(`imports.columnNames.${ch.field}`)}</th>
                  <td>
                    <del>{ch.from ?? t('common.none')}</del>
                  </td>
                  <td>
                    <ins>{ch.to ?? t('common.none')}</ins>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {c.status === 'PENDING' ? (
        <section className="card" aria-labelledby="decide-title">
          <h2 id="decide-title">{t('reviews.decideTitle')}</h2>
          <DecisionForms id={c.id} kind="profileChange" />
        </section>
      ) : (
        <section className="card" aria-labelledby="decision-title">
          <h2 id="decision-title">{t('reviews.decisionTitle')}</h2>
          <dl className="details">
            <div>
              <dt>{t('reviews.decidedBy')}</dt>
              <dd>{c.decidedBy?.name ?? t('reviews.byStudent')}</dd>
            </div>
            {c.decidedAt && (
              <div>
                <dt>{t('reviews.decidedAt')}</dt>
                <dd>{date(c.decidedAt)}</dd>
              </div>
            )}
            {c.decisionReason && (
              <div>
                <dt>{t('reviews.reason')}</dt>
                <dd>{c.decisionReason}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}
