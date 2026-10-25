import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AUDIT_CATEGORIES,
  AUDIT_SCOPES,
  type AuditFacetsResponse,
  ListAuditLogsQuerySchema,
  type ListAuditLogsResponse,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ReportDownload } from '@/components/report-download';
import { apiFetch } from '@/lib/api';
import { AUDIT_FILTER_KEYS } from '@/lib/audit';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { AuditTabs } from './audit-tabs';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('audit'))('title') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/** Query string of the non-empty values. */
const toParams = (values: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(values).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );

/**
 * The Training Director's audit log (§15.3): every recorded action, searchable
 * and filterable by staff member, action, record type, period and outcome;
 * the "decisions" view lists administrative decisions only (§3.2).
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('audit.read');
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const raw = await searchParams;
  const decisionsView = param(raw, 'decisions') === 'true';
  const parsed = ListAuditLogsQuerySchema.safeParse({
    ...Object.fromEntries(AUDIT_FILTER_KEYS.map((k) => [k, param(raw, k)])),
    // Staff actions by default (§15.1); every event on request.
    scope: param(raw, 'scope') ?? 'staff',
    page: param(raw, 'page') ?? 1,
  });
  const invalid = !parsed.success;
  const query = parsed.success
    ? parsed.data
    : ListAuditLogsQuerySchema.parse({
        scope: 'staff',
        decisions: decisionsView ? 'true' : undefined,
      });
  const filters: Record<string, string | undefined> = {
    q: query.q,
    actor: query.actor,
    scope: query.scope,
    category: query.category,
    action: query.action,
    resourceType: query.resourceType,
    resourceId: query.resourceId,
    outcome: query.outcome,
    decisions: query.decisions ? 'true' : undefined,
    from: query.from,
    to: query.to,
  };
  const params = toParams({
    ...filters,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  const [result, facets] = await Promise.all([
    apiFetch<ListAuditLogsResponse>(`/audit-logs?${params}`, { accessToken: token }),
    apiFetch<AuditFacetsResponse>('/audit-logs/facets', { accessToken: token }),
  ]);
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    next.delete('pageSize');
    return `/audit?${next.toString()}`;
  };
  const back = `/audit?${toParams(filters).toString()}`;
  const withoutRecord = toParams({ ...filters, resourceId: undefined, resourceType: undefined });
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium' });
  const actions = facets.ok ? facets.data.actions : [];
  const exportError = param(raw, 'exportError');

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('audit.title')}</h1>
        <p className="muted">{t('audit.intro')}</p>
      </div>
      <AuditTabs current={decisionsView ? 'decisions' : 'all'} />

      <section className="card stack" aria-labelledby="audit-filters">
        <h2 id="audit-filters" className="sr-only">
          {t('audit.filters')}
        </h2>
        {invalid && (
          <p className="alert alert-error" role="alert">
            {t('audit.invalidFilters')}
          </p>
        )}
        <form className="filters" role="search" method="get" action="/audit">
          {decisionsView && <input type="hidden" name="decisions" value="true" />}
          <label className="sr-only" htmlFor="audit-q">
            {t('common.search')}
          </label>
          <input
            id="audit-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ''}
            placeholder={t('audit.searchPlaceholder')}
          />
          <select
            name="actor"
            defaultValue={query.actor ?? ''}
            aria-label={t('audit.columns.actor')}
          >
            <option value="">{t('audit.anyActor')}</option>
            {facets.ok &&
              facets.data.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {t(`roles.${a.role}`)}
                  {a.status === 'SUSPENDED' ? ` (${t('statuses.SUSPENDED')})` : ''}
                </option>
              ))}
          </select>
          <select name="scope" defaultValue={query.scope} aria-label={t('audit.scopeLabel')}>
            {AUDIT_SCOPES.map((s) => (
              <option key={s} value={s}>
                {t(`audit.scopes.${s}`)}
              </option>
            ))}
          </select>
          <select
            name="category"
            defaultValue={query.category ?? ''}
            aria-label={t('audit.columns.category')}
          >
            <option value="">{t('audit.anyCategory')}</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`audit.categories.${c}`)}
              </option>
            ))}
          </select>
          <select
            name="action"
            defaultValue={query.action ?? ''}
            aria-label={t('audit.columns.action')}
          >
            <option value="">{t('audit.anyAction')}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {t(`audit.actions.${a}`)}
              </option>
            ))}
          </select>
          <select
            name="resourceType"
            defaultValue={query.resourceType ?? ''}
            aria-label={t('audit.columns.resource')}
          >
            <option value="">{t('audit.anyResource')}</option>
            {facets.ok &&
              facets.data.resourceTypes.map((r) => (
                <option key={r} value={r}>
                  {t(`audit.resources.${r}`)}
                </option>
              ))}
          </select>
          <select
            name="outcome"
            defaultValue={query.outcome ?? ''}
            aria-label={t('audit.columns.outcome')}
          >
            <option value="">{t('audit.anyOutcome')}</option>
            <option value="SUCCESS">{t('audit.outcomes.SUCCESS')}</option>
            <option value="FAILURE">{t('audit.outcomes.FAILURE')}</option>
          </select>
          <label className="filter-date">
            <span>{t('audit.from')}</span>
            <input type="date" name="from" defaultValue={query.from ?? ''} />
          </label>
          <label className="filter-date">
            <span>{t('audit.to')}</span>
            <input type="date" name="to" defaultValue={query.to ?? ''} />
          </label>
          {query.resourceId && <input type="hidden" name="resourceId" value={query.resourceId} />}
          <button type="submit" className="btn btn-secondary">
            {t('audit.filter')}
          </button>
        </form>
        {query.resourceId && (
          <p className="small">
            {t('audit.oneRecord', { id: query.resourceId })}{' '}
            <Link href={`/audit?${withoutRecord.toString()}`}>{t('audit.clearRecord')}</Link>
          </p>
        )}
      </section>

      <section className="card stack" aria-labelledby="audit-results">
        <h2 id="audit-results" className="sr-only">
          {t('audit.results')}
        </h2>
        {!result.ok ? (
          <p className="alert alert-error" role="alert">
            {t('audit.loadFailed')}
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="empty">{t('audit.empty')}</p>
        ) : (
          <>
            <p className="muted small" role="status">
              {t('audit.count', { count: result.data.total })}
            </p>
            <div className="table-wrap">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th scope="col">{t('audit.columns.time')}</th>
                    <th scope="col">{t('audit.columns.actor')}</th>
                    <th scope="col">{t('audit.columns.action')}</th>
                    <th scope="col">{t('audit.columns.resource')}</th>
                    <th scope="col">{t('audit.columns.outcome')}</th>
                    <th scope="col">{t('audit.columns.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <Link href={`/audit/${e.id}`}>{when(e.at)}</Link>
                      </td>
                      <td>
                        {e.actor ? (
                          <>
                            {e.actor.name ?? '—'}
                            {e.actor.role && (
                              <>
                                <br />
                                <span className="muted small">{t(`roles.${e.actor.role}`)}</span>
                              </>
                            )}
                          </>
                        ) : (
                          <span className="muted">{t('audit.system')}</span>
                        )}
                      </td>
                      <td>
                        {t(`audit.actions.${e.action}`)}
                        <br />
                        <span className="muted small">{t(`audit.categories.${e.category}`)}</span>
                      </td>
                      <td>
                        {t(`audit.resources.${e.resourceType}`)}
                        {e.resourceId && (
                          <>
                            <br />
                            <span className="muted small mono" dir="ltr">
                              {e.resourceId.length > 13
                                ? `${e.resourceId.slice(0, 8)}…`
                                : e.resourceId}
                            </span>
                          </>
                        )}
                      </td>
                      <td>
                        <span
                          className={`status status-${e.outcome === 'SUCCESS' ? 'approved' : 'rejected'}`}
                        >
                          {t(`audit.outcomes.${e.outcome}`)}
                        </span>
                      </td>
                      <td className="small">{e.reason ?? ''}</td>
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

      {user.permissions.includes('reports.export') && (
        <section className="card stack" aria-labelledby="audit-export">
          <h2 id="audit-export">{t('audit.exportTitle')}</h2>
          <p className="muted small">{t('audit.exportHint')}</p>
          <ReportDownload
            report="audit"
            formats={['xlsx', 'csv']}
            params={filters}
            back={back}
            error={exportError}
          />
        </section>
      )}
    </div>
  );
}
