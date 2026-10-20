import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type Group, type VerificationReviewDetail } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { DecisionForms, LinkCandidateForm } from '../../review-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reviews'))('verification.title') };
}

/** §4.2 Case B review: who is asking, what they submitted, and records that could be theirs. */
export default async function VerificationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission('students.manage');
  const { id } = await params;
  const token = await accessToken();
  const [result, groups] = await Promise.all([
    apiFetch<VerificationReviewDetail>(`/student-verifications/${encodeURIComponent(id)}`, {
      accessToken: token,
    }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  if (!result.ok) notFound();
  const v = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const pending = v.status === 'PENDING';

  return (
    <div className="stack-lg">
      <p>
        <Link href="/reviews">← {t('reviews.back')}</Link>
      </p>
      <div className="row-between">
        <h1>{t('reviews.verification.title')}</h1>
        <span className={`status status-${v.status.toLowerCase()}`}>
          {t(`reviews.statuses.${v.status}`)}
        </span>
      </div>

      <section className="card stack" aria-labelledby="submitted-title">
        <h2 id="submitted-title">{t('reviews.verification.submitted')}</h2>
        <dl className="details">
          <div>
            <dt>{t('reviews.verification.account')}</dt>
            <dd dir="ltr">{v.account.email}</dd>
          </div>
          <div>
            <dt>{t('students.fields.fullName')}</dt>
            <dd>{v.submitted.fullName}</dd>
          </div>
          <div>
            <dt>{t('students.fields.seatNumber')}</dt>
            <dd dir="ltr">{v.submitted.seatNumber}</dd>
          </div>
          <div>
            <dt>{t('reviews.columns.submitted')}</dt>
            <dd>{date(v.createdAt)}</dd>
          </div>
        </dl>
        <p className="alert alert-info">
          <strong>{t(`reviews.issues.${v.issue}`)}</strong> — {t(`reviews.issueHints.${v.issue}`)}
        </p>
      </section>

      <section className="card stack" aria-labelledby="candidates-title">
        <h2 id="candidates-title">{t('reviews.verification.candidates')}</h2>
        {v.candidates.length === 0 ? (
          <p className="empty">{t('reviews.verification.candidatesEmpty')}</p>
        ) : (
          v.candidates.map((c) => (
            <article key={c.id} className="card stack">
              <div className="row-between">
                <strong>
                  <Link href={`/students/${c.id}`}>{c.fullName}</Link>
                </strong>
                <span className="muted small">
                  {c.reasons.map((r) => t(`reviews.verification.reasons.${r}`)).join(' · ')}
                </span>
              </div>
              <dl className="details">
                <div>
                  <dt>{t('students.fields.seatNumber')}</dt>
                  <dd dir="ltr">{c.seatNumber}</dd>
                </div>
                <div>
                  <dt>{t('students.fields.universityEmail')}</dt>
                  <dd dir="ltr">{c.universityEmail ?? t('common.none')}</dd>
                </div>
                <div>
                  <dt>{t('students.fields.group')}</dt>
                  <dd>{c.group?.name ?? t('students.noGroup')}</dd>
                </div>
                <div>
                  <dt>{t('students.columns.account')}</dt>
                  <dd>{c.account ? c.account.email : t('students.notLinked')}</dd>
                </div>
              </dl>
              {pending && !c.account && (
                <LinkCandidateForm id={v.id} studentId={c.id} name={c.fullName} />
              )}
            </article>
          ))
        )}
      </section>

      {pending ? (
        <section className="card" aria-labelledby="decide-title">
          <h2 id="decide-title">{t('reviews.decideTitle')}</h2>
          <DecisionForms
            id={v.id}
            kind="verification"
            groups={
              user.permissions.includes('groups.manage') && groups.ok
                ? groups.data.filter((g) => !g.archived)
                : null
            }
          />
        </section>
      ) : (
        <section className="card" aria-labelledby="decision-title">
          <h2 id="decision-title">{t('reviews.decisionTitle')}</h2>
          <dl className="details">
            <div>
              <dt>{t('reviews.decidedBy')}</dt>
              <dd>{v.decidedBy?.name ?? t('common.none')}</dd>
            </div>
            {v.decidedAt && (
              <div>
                <dt>{t('reviews.decidedAt')}</dt>
                <dd>{date(v.decidedAt)}</dd>
              </div>
            )}
            {v.decisionReason && (
              <div>
                <dt>{t('reviews.reason')}</dt>
                <dd>{v.decisionReason}</dd>
              </div>
            )}
            {v.linkedStudentId && (
              <div>
                <dt>{t('reviews.verification.linkedRecord')}</dt>
                <dd>
                  <Link href={`/students/${v.linkedStudentId}`}>
                    {t('reviews.verification.openRecord')}
                  </Link>
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}
