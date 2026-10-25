import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AUDIT_CATEGORIES,
  FacultyActivityQuerySchema,
  type FacultyActivityResponse,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ReportDownload } from '@/components/report-download';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
import { AuditTabs } from '../audit-tabs';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('audit'))('activityTitle') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/**
 * Faculty activity history (§15.1, §3.2): what each staff member did in a
 * period — also those who did nothing — with links into their full log.
 */
export default async function FacultyActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('audit.read');
  const t = await getTranslations();
  const format = await getFormatter();
  const raw = await searchParams;
  const parsed = FacultyActivityQuerySchema.safeParse({
    from: param(raw, 'from'),
    to: param(raw, 'to'),
  });
  const query = parsed.success ? parsed.data : {};
  const params = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  const result = await apiFetch<FacultyActivityResponse>(`/audit-logs/activity?${params}`, {
    accessToken: await accessToken(),
  });
  const day = (date: string) => format.dateTime(dayValue(date), { dateStyle: 'medium' });
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const data = result.ok ? result.data : null;

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('audit.title')}</h1>
        <p className="muted">{t('audit.activityIntro')}</p>
      </div>
      <AuditTabs current="activity" />

      <section className="card stack" aria-labelledby="period-title">
        <h2 id="period-title" className="sr-only">
          {t('audit.period')}
        </h2>
        {!parsed.success && (
          <p className="alert alert-error" role="alert">
            {t('audit.invalidFilters')}
          </p>
        )}
        <form className="filters" method="get" action="/audit/activity">
          <label className="filter-date">
            <span>{t('audit.from')}</span>
            <input type="date" name="from" defaultValue={data?.from ?? ''} />
          </label>
          <label className="filter-date">
            <span>{t('audit.to')}</span>
            <input type="date" name="to" defaultValue={data?.to ?? ''} />
          </label>
          <button type="submit" className="btn btn-secondary">
            {t('audit.filter')}
          </button>
        </form>
        {data && (
          <p className="muted small">
            {t('audit.periodText', { from: day(data.from), to: day(data.to) })}
          </p>
        )}
      </section>

      {!data ? (
        <p className="alert alert-error" role="alert">
          {t('audit.loadFailed')}
        </p>
      ) : (
        <>
          <section className="card stack" aria-labelledby="totals-title">
            <h2 id="totals-title">{t('audit.totals')}</h2>
            <ul className="stat-grid">
              <li className="stat">
                <span className="stat-value">{data.totals.actions}</span>
                <span className="stat-label">{t('audit.actionsCount')}</span>
              </li>
              <li className="stat">
                <span className="stat-value">{data.totals.decisions}</span>
                <span className="stat-label">{t('audit.decisionsCount')}</span>
              </li>
              <li className="stat">
                <span className="stat-value">{data.totals.failures}</span>
                <span className="stat-label">{t('audit.failuresCount')}</span>
              </li>
              <li className="stat">
                <span className="stat-value">
                  {data.totals.activeStaff}
                  <span className="stat-of"> / {data.rows.length}</span>
                </span>
                <span className="stat-label">{t('audit.activeStaff')}</span>
              </li>
            </ul>
          </section>

          <section className="card stack" aria-labelledby="staff-title">
            <h2 id="staff-title">{t('audit.staffTitle')}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('audit.columns.actor')}</th>
                    <th scope="col">{t('audit.actionsCount')}</th>
                    <th scope="col">{t('audit.decisionsCount')}</th>
                    <th scope="col">{t('audit.failuresCount')}</th>
                    <th scope="col">{t('audit.byCategory')}</th>
                    <th scope="col">{t('audit.lastAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const log = new URLSearchParams({
                      actor: r.actor.id,
                      scope: 'all',
                      from: data.from,
                      to: data.to,
                    });
                    return (
                      <tr key={r.actor.id}>
                        <td>
                          <Link href={`/audit?${log.toString()}`}>{r.actor.name}</Link>
                          <br />
                          <span className="muted small">
                            {t(`roles.${r.actor.role}`)}
                            {r.actor.status && r.actor.status !== 'ACTIVE'
                              ? ` · ${t(`statuses.${r.actor.status}`)}`
                              : ''}
                            {r.actor.status === null ? ` · ${t('audit.accountRemoved')}` : ''}
                          </span>
                        </td>
                        <td>{r.total}</td>
                        <td>
                          {r.decisions > 0 ? (
                            <Link href={`/audit?${log.toString()}&decisions=true`}>
                              {r.decisions}
                            </Link>
                          ) : (
                            0
                          )}
                        </td>
                        <td>
                          {r.failures > 0 ? (
                            <Link href={`/audit?${log.toString()}&outcome=FAILURE`}>
                              {r.failures}
                            </Link>
                          ) : (
                            0
                          )}
                        </td>
                        <td>
                          {r.total === 0 ? (
                            <span className="muted">{t('audit.noActivity')}</span>
                          ) : (
                            <ul className="chips">
                              {AUDIT_CATEGORIES.filter((c) => r.categories[c]).map((c) => (
                                <li key={c} className="chip">
                                  <Link href={`/audit?${log.toString()}&category=${c}`}>
                                    {t(`audit.categories.${c}`)} {r.categories[c]}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td>{r.lastActionAt ? when(r.lastActionAt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {user.permissions.includes('reports.export') && (
            <section className="card stack" aria-labelledby="activity-export">
              <h2 id="activity-export">{t('audit.activityExport')}</h2>
              <ReportDownload
                report="faculty-activity"
                formats={['xlsx', 'csv', 'pdf']}
                params={{ from: data.from, to: data.to }}
                back={`/audit/activity?${params.toString()}`}
                error={param(raw, 'exportError')}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
