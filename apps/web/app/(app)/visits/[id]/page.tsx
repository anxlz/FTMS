import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type VisitDetail, type VisitHistoryEntry } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { timeRange, VisitStatus } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { showValue } from '@/lib/display';
import { accessToken, requireUser } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
import {
  CancelVisitForm,
  RemoveFileButton,
  RestoreVisitForm,
  UploadFileForm,
} from '../visit-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('visits'))('detailTitle') };
}

/**
 * Visit details (§6.3, §7.1). Students reach only visits of their own group
 * (the API answers 404 otherwise); staff also manage the visit here.
 */
export default async function VisitPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const raw = await searchParams;
  const token = await accessToken();
  const result = await apiFetch<VisitDetail>(`/visits/${encodeURIComponent(id)}`, {
    accessToken: token,
  });
  if (!result.ok) notFound();
  const v = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const isStaff = user.role !== 'STUDENT';
  const canManage = user.permissions.includes('visits.manage');
  const history =
    isStaff &&
    (await apiFetch<VisitHistoryEntry[]>(`/visits/${encodeURIComponent(id)}/history`, {
      accessToken: token,
    }));
  const clock = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
  const graceUntil = new Date(
    Date.parse(v.startsAt) + v.timing.graceMinutes * 60_000,
  ).toISOString();
  const mapHref =
    v.mapUrl ??
    (v.latitude !== null && v.longitude !== null
      ? `https://www.google.com/maps?q=${v.latitude},${v.longitude}`
      : null);
  const notice =
    typeof raw.notice === 'string' &&
    ['created', 'updated', 'cancelled', 'restored'].includes(raw.notice)
      ? raw.notice
      : null;
  const notified = Number(typeof raw.notified === 'string' ? raw.notified : 0) || 0;

  return (
    <div className="stack-lg">
      <p>
        <Link href={isStaff && canManage ? '/visits' : '/calendar'}>
          ← {isStaff && canManage ? t('visits.back') : t('calendar.back')}
        </Link>
      </p>
      {notice && (
        <p className="alert alert-success" role="status">
          {t(`visits.${notice}`, { count: notified })}
        </p>
      )}
      <div className="row-between">
        <h1>{v.title}</h1>
        <VisitStatus visit={v} />
      </div>
      {v.status === 'CANCELLED' && (
        <p className="alert alert-error">
          {t('calendar.cancelReason', { reason: v.cancelReason ?? '—' })}
        </p>
      )}

      {v.cover && (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed link to private storage
        <img
          className="visit-cover"
          src={v.cover.url}
          alt={t('visits.coverAlt', { title: v.title })}
        />
      )}

      <section className="card" aria-labelledby="when-title">
        <h2 id="when-title">{t('visits.fields.when')}</h2>
        <dl className="details">
          <div>
            <dt>{t('visits.fields.date')}</dt>
            <dd>{format.dateTime(dayValue(v.date), { dateStyle: 'full' })}</dd>
          </div>
          <div>
            <dt>{t('visits.fields.time')}</dt>
            <dd dir="ltr">{timeRange(v)}</dd>
          </div>
          <div>
            <dt>{t('visits.fields.checkIn')}</dt>
            <dd>
              {t('visits.checkInWindow', {
                opens: clock(v.checkInOpensAt),
                grace: clock(graceUntil),
                closes: clock(v.checkInClosesAt),
              })}
            </dd>
          </div>
          {isStaff && (
            <div>
              <dt>{t('visits.fields.groups')}</dt>
              <dd>{format.list(v.groups.map((g) => g.name))}</dd>
            </div>
          )}
          {isStaff && v.schedule && (
            <div>
              <dt>{t('visits.fields.schedule')}</dt>
              <dd>
                {v.schedule.title}
                {v.detached && <span className="badge">{t('visits.detached')}</span>}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {(v.locationName || mapHref) && (
        <section className="card" aria-labelledby="where-title">
          <h2 id="where-title">{t('visits.fields.location')}</h2>
          {v.locationName && <p>{v.locationName}</p>}
          {v.latitude !== null && (
            <p className="muted small" dir="ltr">
              {v.latitude}, {v.longitude}
            </p>
          )}
          {mapHref && (
            <p>
              <a href={mapHref} target="_blank" rel="noopener noreferrer">
                {t('visits.openMap')}
              </a>
            </p>
          )}
        </section>
      )}

      {v.description && (
        <section className="card" aria-labelledby="about-title">
          <h2 id="about-title">{t('visits.fields.description')}</h2>
          <p className="pre-line">{v.description}</p>
        </section>
      )}

      <section className="card stack" aria-labelledby="docs-title">
        <h2 id="docs-title">{t('visits.files.documents')}</h2>
        {v.documents.length === 0 ? (
          <p className="empty">{t('visits.files.noDocuments')}</p>
        ) : (
          <ul className="file-list">
            {v.documents.map((d) => (
              <li key={d.id}>
                <a href={d.url} download={d.fileName}>
                  {d.fileName}
                </a>{' '}
                <span className="muted small">
                  ({format.number(d.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB)
                </span>
                {canManage && <RemoveFileButton id={v.id} fileId={d.id} name={d.fileName} />}
              </li>
            ))}
          </ul>
        )}
        {canManage && v.cover && (
          <p className="small">
            {t('visits.files.kinds.COVER')}: {v.cover.fileName}{' '}
            <RemoveFileButton id={v.id} fileId={v.cover.id} name={v.cover.fileName} />
          </p>
        )}
        {canManage && v.status === 'SCHEDULED' && (
          <details>
            <summary>{t('visits.files.add')}</summary>
            <UploadFileForm id={v.id} />
          </details>
        )}
      </section>

      {canManage && (
        <section className="card stack" aria-labelledby="manage-title">
          <h2 id="manage-title">{t('visits.manage')}</h2>
          {v.status === 'SCHEDULED' && (
            <p>
              <Link href={`/visits/${v.id}/edit`} className="btn btn-secondary">
                {t('visits.edit')}
              </Link>
            </p>
          )}
          {v.phase !== 'FINISHED' &&
            (v.status === 'SCHEDULED' ? (
              <CancelVisitForm id={v.id} />
            ) : (
              <RestoreVisitForm id={v.id} />
            ))}
          {v.phase === 'FINISHED' && <p className="muted small">{t('visits.finishedNote')}</p>}
        </section>
      )}

      {history && history.ok && (
        <section className="card stack" aria-labelledby="history-title">
          <h2 id="history-title">{t('visits.history')}</h2>
          <ol className="history">
            {[...history.data].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`}>
                <p>
                  <strong>
                    {t.has(`visits.actions.${h.action}`)
                      ? t(`visits.actions.${h.action}`)
                      : h.action}
                  </strong>{' '}
                  <span className="muted small">
                    {format.dateTime(new Date(h.at), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                    {h.actorName ?? '—'}
                  </span>
                </p>
                {h.reason && (
                  <p className="small">{t('visits.historyReason', { reason: h.reason })}</p>
                )}
                {(h.before || h.after) && (
                  <ul className="changes">
                    {[
                      ...new Set([...Object.keys(h.before ?? {}), ...Object.keys(h.after ?? {})]),
                    ].map((key) => (
                      <li key={key}>
                        {t.has(`visits.historyFields.${key}`)
                          ? t(`visits.historyFields.${key}`)
                          : key}
                        : {h.before && key in h.before && <del>{showValue(h.before[key])}</del>}
                        {h.before && key in h.before && ' → '}
                        <ins>{showValue(h.after?.[key])}</ins>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
