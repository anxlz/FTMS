import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ATTENDANCE_STANDINGS,
  AttendanceSummaryQuerySchema,
  type AttendanceSummaryResponse,
  type Group,
} from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { ReportDownload } from '@/components/report-download';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reports'))('title') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/**
 * Training-wide reports (§3.2, §19), each shown only to accounts holding its
 * permissions — the API enforces the same rules on every download.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('reports.export');
  const canAttendance = user.permissions.includes('attendance.read');
  const canAudit = user.permissions.includes('audit.read');
  const t = await getTranslations();
  const token = await accessToken();
  const raw = await searchParams;
  const parsed = AttendanceSummaryQuerySchema.safeParse({
    group: param(raw, 'group'),
    q: param(raw, 'q'),
    standing: param(raw, 'standing'),
  });
  const query = parsed.success ? parsed.data : {};
  const params = new URLSearchParams(
    Object.entries(query).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  );
  const [summary, groups] = await Promise.all([
    canAttendance
      ? apiFetch<AttendanceSummaryResponse>(`/reports/attendance-summary?${params}`, {
          accessToken: token,
        })
      : null,
    canAttendance ? apiFetch<Group[]>('/groups', { accessToken: token }) : null,
  ]);
  const back = `/reports?${params.toString()}`;
  const exportError = param(raw, 'exportError');
  const data = summary?.ok ? summary.data : null;

  return (
    <div className="stack-lg">
      <div>
        <h1>{t('reports.title')}</h1>
        <p className="muted">{t('reports.intro')}</p>
      </div>
      {exportError && (
        <p className="alert alert-error" role="alert">
          {t.has(`errors.${exportError}`)
            ? t(`errors.${exportError}`, { minutes: 1 })
            : t('errors.INTERNAL_ERROR')}
        </p>
      )}

      {canAttendance && (
        <section className="card stack" aria-labelledby="summary-title">
          <div className="row-between">
            <h2 id="summary-title">{t('reports.summaryTitle')}</h2>
            <Link href="/attendance">{t('reports.openAttendance')}</Link>
          </div>
          <p className="muted small">{t('reports.summaryHint')}</p>
          <form className="filters" role="search" method="get" action="/reports">
            <label className="sr-only" htmlFor="report-q">
              {t('common.search')}
            </label>
            <input
              id="report-q"
              name="q"
              type="search"
              defaultValue={query.q ?? ''}
              placeholder={t('reports.searchPlaceholder')}
            />
            <select
              name="group"
              defaultValue={query.group ?? ''}
              aria-label={t('reports.columns.group')}
            >
              <option value="">{t('reports.allGroups')}</option>
              <option value="none">{t('reports.noGroup')}</option>
              {groups?.ok &&
                groups.data.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
            <select
              name="standing"
              defaultValue={query.standing ?? ''}
              aria-label={t('reports.columns.standing')}
            >
              <option value="">{t('reports.anyStanding')}</option>
              {ATTENDANCE_STANDINGS.map((s) => (
                <option key={s} value={s}>
                  {t(`reports.standings.${s}`)}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-secondary">
              {t('reports.filter')}
            </button>
          </form>

          {!data ? (
            <p className="alert alert-error" role="alert">
              {t('reports.loadFailed')}
            </p>
          ) : (
            <>
              {data.allowedAbsences === null && (
                <p className="alert alert-info">{t('reports.noProgram')}</p>
              )}
              <ul className="stat-grid">
                <li className="stat">
                  <span className="stat-value">{data.totals.students}</span>
                  <span className="stat-label">{t('reports.students')}</span>
                </li>
                <li className="stat">
                  <span className="stat-value">{data.totals.over}</span>
                  <span className="stat-label">{t('reports.standings.over')}</span>
                </li>
                <li className="stat">
                  <span className="stat-value">{data.totals.atLimit}</span>
                  <span className="stat-label">{t('reports.standings.atLimit')}</span>
                </li>
                <li className="stat">
                  <span className="stat-value">{data.totals.absent}</span>
                  <span className="stat-label">{t('attendance.absentCount')}</span>
                </li>
                <li className="stat">
                  <span className="stat-value">{data.totals.late}</span>
                  <span className="stat-label">{t('attendance.lateCount')}</span>
                </li>
              </ul>
              {data.rows.length === 0 ? (
                <p className="empty">{t('reports.empty')}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t('reports.columns.student')}</th>
                        <th scope="col">{t('reports.columns.group')}</th>
                        <th scope="col">{t('reports.columns.recorded')}</th>
                        <th scope="col">{t('attendance.status.PRESENT')}</th>
                        <th scope="col">{t('attendance.status.LATE')}</th>
                        <th scope="col">{t('attendance.status.ABSENT')}</th>
                        <th scope="col">{t('reports.columns.lateMinutes')}</th>
                        <th scope="col">{t('reports.columns.remaining')}</th>
                        <th scope="col">{t('reports.columns.standing')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.studentId}>
                          <td>
                            <Link href={`/students/${r.studentId}`}>{r.fullName}</Link>
                            <br />
                            <span className="muted small" dir="ltr">
                              {r.seatNumber}
                            </span>
                          </td>
                          <td>{r.group?.name ?? t('reports.noGroup')}</td>
                          <td>{r.recorded}</td>
                          <td>{r.present}</td>
                          <td>{r.late}</td>
                          <td>{r.absent}</td>
                          <td>{r.lateMinutes}</td>
                          <td>
                            {data.allowedAbsences === null ? (
                              '—'
                            ) : (
                              <>
                                {r.remainingAbsences}
                                <span className="muted"> / {data.allowedAbsences}</span>
                              </>
                            )}
                          </td>
                          <td>
                            <span className={`status status-standing-${r.standing.toLowerCase()}`}>
                              {t(`reports.standings.${r.standing}`)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h3 className="h3">{t('reports.downloadSummary')}</h3>
              <ReportDownload
                report="attendance-summary"
                formats={['xlsx', 'csv', 'pdf']}
                params={Object.fromEntries(params)}
                back={back}
              />
            </>
          )}
        </section>
      )}

      {canAttendance && (
        <section className="card stack" aria-labelledby="records-title">
          <h2 id="records-title">{t('reports.recordsTitle')}</h2>
          <p className="muted small">{t('reports.recordsHint')}</p>
          <p>
            <Link href="/attendance">{t('reports.openAttendance')}</Link>
          </p>
        </section>
      )}

      {canAudit && (
        <section className="card stack" aria-labelledby="activity-title">
          <h2 id="activity-title">{t('reports.activityTitle')}</h2>
          <p className="muted small">{t('reports.activityHint')}</p>
          <ReportDownload
            report="faculty-activity"
            formats={['xlsx', 'csv', 'pdf']}
            params={{}}
            back={back}
          />
          <p className="small">
            <Link href="/audit/activity">{t('reports.openActivity')}</Link> ·{' '}
            <Link href="/audit">{t('reports.openAudit')}</Link>
          </p>
        </section>
      )}
    </div>
  );
}
