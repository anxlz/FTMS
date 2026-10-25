import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type AuditEntryDetail } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { auditResourceHref } from '@/lib/audit';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { showValue } from '@/lib/display';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('audit'))('detailTitle') };
}

/**
 * One audit event (§15.2, §15.3): who did what to which record and when, the
 * before/after comparison, the reason and outcome, the request context, the
 * record as it is now, and the other events about the same record.
 */
export default async function AuditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission('audit.read');
  const { id } = await params;
  if (!/^[1-9]\d{0,18}$/.test(id)) notFound();
  const result = await apiFetch<AuditEntryDetail>(`/audit-logs/${id}`, {
    accessToken: await accessToken(),
  });
  if (!result.ok) notFound();
  const e = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'full', timeStyle: 'medium' });
  const short = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  // Nested settings appear as dotted paths: each part is labelled ("Timing › Grace period").
  const fieldLabel = (field: string) =>
    field
      .split('.')
      .map((part) => (t.has(`audit.fields.${part}`) ? t(`audit.fields.${part}`) : part))
      .join(' › ');
  // Recorded codes (statuses, sources, roles) and flags are shown in words.
  const value = (v: unknown): string => {
    if (typeof v === 'boolean') return v ? t('audit.yes') : t('audit.no');
    if (typeof v === 'string' && /^[A-Z_]+$/.test(v) && t.has(`audit.values.${v}`)) {
      return t(`audit.values.${v}`);
    }
    if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(value).join(', ');
    return showValue(v);
  };
  const href = e.resource?.exists ? auditResourceHref(e.resource) : null;
  const metadata = Object.entries(e.metadata ?? {});
  const canSeeAccounts = user.permissions.includes('users.read');

  return (
    <div className="stack-lg">
      <p>
        <Link href="/audit">← {t('audit.back')}</Link>
      </p>
      <div className="row-between">
        <h1>{t(`audit.actions.${e.action}`)}</h1>
        <span className={`status status-${e.outcome === 'SUCCESS' ? 'approved' : 'rejected'}`}>
          {t(`audit.outcomes.${e.outcome}`)}
        </span>
      </div>

      <section className="card" aria-labelledby="event-title">
        <h2 id="event-title" className="sr-only">
          {t('audit.detailTitle')}
        </h2>
        <dl className="details">
          <div>
            <dt>{t('audit.columns.time')}</dt>
            <dd>{when(e.at)}</dd>
          </div>
          <div>
            <dt>{t('audit.columns.actor')}</dt>
            <dd>
              {e.actor ? (
                <>
                  {e.actor.id && canSeeAccounts ? (
                    <Link href={`/admin/users/${e.actor.id}`}>{e.actor.name ?? e.actor.id}</Link>
                  ) : (
                    (e.actor.name ?? '—')
                  )}
                  {e.actor.role && <span className="muted"> · {t(`roles.${e.actor.role}`)}</span>}
                  <br />
                  <span className="muted small">{t('audit.asRecorded')}</span>
                </>
              ) : (
                t('audit.system')
              )}
            </dd>
          </div>
          <div>
            <dt>{t('audit.columns.category')}</dt>
            <dd>{t(`audit.categories.${e.category}`)}</dd>
          </div>
          <div>
            <dt>{t('audit.columns.resource')}</dt>
            <dd>
              {t(`audit.resources.${e.resourceType}`)}
              {e.resource?.label && (
                <>
                  {' — '}
                  {href ? <Link href={href}>{e.resource.label}</Link> : e.resource.label}
                </>
              )}
              {e.resourceId && (
                <>
                  <br />
                  <span className="muted small mono" dir="ltr">
                    {e.resourceId}
                  </span>
                </>
              )}
              {e.resource && !e.resource.exists && e.resourceType !== 'report' && (
                <>
                  <br />
                  <span className="small">{t('audit.recordGone')}</span>
                </>
              )}
            </dd>
          </div>
          {e.reason && (
            <div>
              <dt>{t('audit.columns.reason')}</dt>
              <dd className="pre-line">{e.reason}</dd>
            </div>
          )}
          <div>
            <dt>{t('audit.ip')}</dt>
            <dd dir="ltr">{e.ip ?? '—'}</dd>
          </div>
          <div>
            <dt>{t('audit.userAgent')}</dt>
            <dd className="small" dir="ltr">
              {e.userAgent ?? '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="changes-title">
        <h2 id="changes-title">{t('audit.changes')}</h2>
        {e.changes.length === 0 ? (
          <p className="muted">{t('audit.noChanges')}</p>
        ) : (
          <div className="table-wrap">
            <table className="changes-table">
              <thead>
                <tr>
                  <th scope="col">{t('audit.field')}</th>
                  <th scope="col">{t('audit.before')}</th>
                  <th scope="col">{t('audit.after')}</th>
                </tr>
              </thead>
              <tbody>
                {e.changes.map((c) => (
                  <tr key={c.field} className={c.changed ? 'changed' : 'unchanged'}>
                    <th scope="row">
                      {fieldLabel(c.field)}
                      {c.changed && <span className="sr-only"> — {t('audit.changedMark')}</span>}
                    </th>
                    <td>{c.changed ? <del>{value(c.before)}</del> : value(c.before)}</td>
                    <td>{c.changed ? <ins>{value(c.after)}</ins> : value(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('audit.changesHint')}</p>
      </section>

      {metadata.length > 0 && (
        <section className="card stack" aria-labelledby="metadata-title">
          <h2 id="metadata-title">{t('audit.metadata')}</h2>
          <dl className="details">
            {metadata.map(([key, v]) => (
              <div key={key}>
                <dt>{fieldLabel(key)}</dt>
                <dd className="small">{value(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {e.resourceId && (
        <section className="card stack" aria-labelledby="related-title">
          <h2 id="related-title">{t('audit.related')}</h2>
          {e.related.length === 0 ? (
            <p className="muted">{t('audit.noRelated')}</p>
          ) : (
            <ol className="history">
              {e.related.map((r) => (
                <li key={r.id}>
                  <p>
                    <Link href={`/audit/${r.id}`}>
                      <strong>{t(`audit.actions.${r.action}`)}</strong>
                    </Link>{' '}
                    <span className="muted small">
                      {short(r.at)} · {r.actor?.name ?? t('audit.system')}
                    </span>
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p className="small">
            <Link
              href={`/audit?scope=all&resourceType=${e.resourceType}&resourceId=${encodeURIComponent(e.resourceId)}`}
            >
              {t('audit.allForRecord')}
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}
