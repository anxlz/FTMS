import type { Metadata } from 'next';
import Link from 'next/link';
import {
  type ListProfileChangesResponse,
  type ListVerificationsResponse,
  REQUEST_STATUSES,
  type RequestStatus,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reviews'))('title') };
}

/** Review queues: protected profile changes (§4.4) and accounts awaiting verification (§4.2). */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('profile_changes.decide', 'students.manage');
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const raw = (await searchParams).status;
  const status: RequestStatus =
    typeof raw === 'string' && (REQUEST_STATUSES as readonly string[]).includes(raw)
      ? (raw as RequestStatus)
      : 'PENDING';
  const query = `?status=${status}&pageSize=100`;
  const canChanges = user.permissions.includes('profile_changes.decide');
  const canVerify = user.permissions.includes('students.manage');
  const [changes, verifications] = await Promise.all([
    canChanges
      ? apiFetch<ListProfileChangesResponse>(`/profile-changes${query}`, { accessToken: token })
      : null,
    canVerify
      ? apiFetch<ListVerificationsResponse>(`/student-verifications${query}`, {
          accessToken: token,
        })
      : null,
  ]);
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack-lg">
      <h1>{t('reviews.title')}</h1>
      <nav className="tabs" aria-label={t('reviews.statusFilter')}>
        {REQUEST_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/reviews?status=${s}`}
            className={`tab${status === s ? ' tab-active' : ''}`}
            aria-current={status === s ? 'page' : undefined}
          >
            {t(`reviews.statuses.${s}`)}
          </Link>
        ))}
      </nav>

      {changes && (
        <section className="card stack" aria-labelledby="changes-title">
          <h2 id="changes-title">
            {t('reviews.profileChanges')} {changes.ok && `(${changes.data.total})`}
          </h2>
          {!changes.ok ? (
            <p className="alert alert-error">{t('errors.INTERNAL_ERROR')}</p>
          ) : changes.data.items.length === 0 ? (
            <p className="empty">{t('reviews.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('reviews.columns.student')}</th>
                    <th scope="col">{t('reviews.columns.changes')}</th>
                    <th scope="col">{t('reviews.columns.submitted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.data.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/reviews/profile-changes/${c.id}`}>{c.student.fullName}</Link>{' '}
                        <span className="muted small" dir="ltr">
                          {c.student.seatNumber}
                        </span>
                      </td>
                      <td>
                        {c.changes.map((ch) => t(`imports.columnNames.${ch.field}`)).join('، ')}
                      </td>
                      <td>{date(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {verifications && (
        <section className="card stack" aria-labelledby="verifications-title">
          <h2 id="verifications-title">
            {t('reviews.verifications')} {verifications.ok && `(${verifications.data.total})`}
          </h2>
          {!verifications.ok ? (
            <p className="alert alert-error">{t('errors.INTERNAL_ERROR')}</p>
          ) : verifications.data.items.length === 0 ? (
            <p className="empty">{t('reviews.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('reviews.columns.account')}</th>
                    <th scope="col">{t('students.columns.seatNumber')}</th>
                    <th scope="col">{t('reviews.columns.issue')}</th>
                    <th scope="col">{t('reviews.columns.submitted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {verifications.data.items.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <Link href={`/reviews/verifications/${v.id}`}>{v.submitted.fullName}</Link>{' '}
                        <span className="muted small" dir="ltr">
                          {v.account.email}
                        </span>
                      </td>
                      <td dir="ltr">{v.submitted.seatNumber}</td>
                      <td>{t(`reviews.issues.${v.issue}`)}</td>
                      <td>{date(v.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
