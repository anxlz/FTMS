import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ATTENDANCE_FILTER_STATUSES, type VisitAttendanceResponse } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AttendanceBadge } from '@/components/attendance-badge';
import { ExportForm } from '@/components/export-form';
import { timeRange } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dayValue } from '@/lib/calendar';
import { CorrectionForm } from './correction-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('attendance'))('visitTitle') };
}

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

/** Keeps a name in another script from reordering the sentence around it (bidi isolate). */
const isolate = (text: string) =>
  `${String.fromCodePoint(0x2068)}${text}${String.fromCodePoint(0x2069)}`;

/**
 * One visit's attendance (§10.3): every expected student with status, check-in
 * time, lateness, how it was recorded, the captured location and any
 * correction — with filters, corrections (§8.4) and the report download. Below
 * it, every guest submission (Phase 8) as typed, unverified, with what it
 * matched, so staff can review and correct.
 */
export default async function VisitAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('attendance.read');
  const { id } = await params;
  const raw = await searchParams;
  const filters = { group: one(raw.group), status: one(raw.status), q: one(raw.q) };
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ''));
  const res = await apiFetch<VisitAttendanceResponse>(
    `/visits/${encodeURIComponent(id)}/attendance${query.size ? `?${query}` : ''}`,
    { accessToken: await accessToken() },
  );
  if (!res.ok) notFound();
  const data = res.data;
  const v = data.visit;
  const t = await getTranslations('attendance');
  const format = await getFormatter();
  const canCorrect =
    user.permissions.includes('attendance.correct') &&
    v.status === 'SCHEDULED' &&
    data.window.state !== 'NOT_OPEN';
  const canExport = user.permissions.includes('reports.export');
  const clock = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
  const lastMinute = (iso: string) => clock(new Date(Date.parse(iso) - 60_000).toISOString());
  const exportError = one(raw.exportError) || null;
  const here = `/visits/${v.id}/attendance`;

  return (
    <div className="stack-lg">
      <p>
        <Link href={`/visits/${v.id}`}>← {t('backToVisit')}</Link>
      </p>
      <div className="row-between">
        <h1>{v.title}</h1>
        <Link href={`/visits/${v.id}/qr`} className="btn btn-secondary">
          {t('qrCodes')}
        </Link>
      </div>
      <p className="muted">
        {format.dateTime(dayValue(v.date), { dateStyle: 'full' })} ·{' '}
        <span dir="ltr">{timeRange(v)}</span> · {format.list(v.groups.map((g) => g.name))}
      </p>
      {v.status === 'CANCELLED' && <p className="alert alert-error">{t('visitCancelled')}</p>}
      <p className="alert alert-info">
        {t(`window.${data.window.state}`, {
          opens: clock(data.window.opensAt),
          closes: lastMinute(data.window.closesAt),
        })}{' '}
        {data.absencesProcessed ? t('absencesFinal') : ''}
      </p>

      <ul className="stat-grid">
        <li className="stat">
          <span className="stat-value">{data.counts.expected}</span>
          <span className="stat-label">{t('expected')}</span>
        </li>
        <li className="stat">
          <span className="stat-value">{data.counts.present}</span>
          <span className="stat-label">{t('presentCount')}</span>
        </li>
        <li className="stat">
          <span className="stat-value">{data.counts.late}</span>
          <span className="stat-label">{t('lateCount')}</span>
        </li>
        <li className="stat">
          <span className="stat-value">{data.counts.absent}</span>
          <span className="stat-label">{t('absentCount')}</span>
        </li>
        <li className="stat">
          <span className="stat-value">{data.counts.notRecorded}</span>
          <span className="stat-label">{t('notRecordedCount')}</span>
        </li>
      </ul>

      <section className="card stack" aria-labelledby="records-title">
        <h2 id="records-title">{t('records')}</h2>
        <form method="get" className="filters" role="search">
          <label className="sr-only" htmlFor="f-q">
            {t('searchLabel')}
          </label>
          <input
            id="f-q"
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder={t('searchPlaceholder')}
          />
          <label className="sr-only" htmlFor="f-group">
            {t('columns.group')}
          </label>
          <select id="f-group" name="group" defaultValue={filters.group}>
            <option value="">{t('export.anyGroup')}</option>
            {v.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="f-status">
            {t('columns.status')}
          </label>
          <select id="f-status" name="status" defaultValue={filters.status}>
            <option value="">{t('export.anyStatus')}</option>
            {ATTENDANCE_FILTER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`filterStatus.${s}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary">
            {t('filter')}
          </button>
        </form>

        {data.rows.length === 0 ? (
          <p className="empty">{t('noRows')}</p>
        ) : (
          <div className="table-wrap">
            <table className="attendance-table">
              <thead>
                <tr>
                  <th scope="col">{t('columns.student')}</th>
                  <th scope="col">{t('columns.group')}</th>
                  <th scope="col">{t('columns.status')}</th>
                  <th scope="col">{t('columns.checkIn')}</th>
                  <th scope="col">{t('columns.source')}</th>
                  <th scope="col">{t('columns.location')}</th>
                  <th scope="col">{t('columns.correction')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const r = row.record;
                  const loc = r?.location;
                  return (
                    <tr key={row.student.id}>
                      <th scope="row">
                        <Link href={`/students/${row.student.id}`}>{row.student.fullName}</Link>
                        <br />
                        <span className="muted small" dir="ltr">
                          {row.student.seatNumber}
                        </span>
                        {!row.expected && (
                          <span className="badge" title={t('notExpectedHint')}>
                            {t('notExpected')}
                          </span>
                        )}
                      </th>
                      <td>{row.group?.name ?? '—'}</td>
                      <td>
                        {r ? (
                          <AttendanceBadge status={r.status} minutesLate={r.minutesLate} />
                        ) : (
                          <span className="status status-pending">{t('notRecorded')}</span>
                        )}
                      </td>
                      <td>{r?.checkedInAt ? clock(r.checkedInAt) : '—'}</td>
                      <td>{r ? t(`source.${r.source}`) : '—'}</td>
                      <td>
                        {loc ? (
                          <>
                            <a
                              href={`https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              dir="ltr"
                            >
                              {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                            </a>
                            <br />
                            <span className="muted small">
                              {loc.accuracyMeters !== null &&
                                t('accuracy', { meters: Math.round(loc.accuracyMeters) })}
                              {loc.accuracyMeters !== null && loc.distanceMeters !== null && ' · '}
                              {loc.distanceMeters !== null &&
                                t('distance', { meters: Math.round(loc.distanceMeters) })}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {r?.correction && (
                          <p className="small">
                            {t('correctedBy', {
                              name: isolate(r.correction.by ?? '—'),
                              at: format.dateTime(new Date(r.correction.at), {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              }),
                            })}
                            {r.correction.reason && (
                              <>
                                <br />
                                {r.correction.reason}
                              </>
                            )}
                          </p>
                        )}
                        {canCorrect && (row.expected || r) && (
                          <details>
                            <summary>{r ? t('correction.edit') : t('correction.record')}</summary>
                            <CorrectionForm
                              visitId={v.id}
                              studentId={row.student.id}
                              current={r ? { status: r.status, minutesLate: r.minutesLate } : null}
                            />
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">{t('locationNote')}</p>
        {!canCorrect && v.status === 'SCHEDULED' && data.window.state === 'NOT_OPEN' && (
          <p className="muted small">{t('correctionLater')}</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="guest-title">
        <h2 id="guest-title">{t('guest.title')}</h2>
        <p className="muted small">{t('guest.intro')}</p>
        {data.guestSubmissions.length === 0 ? (
          <p className="empty">{t('guest.none')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('guest.typedName')}</th>
                  <th scope="col">{t('guest.typedSeat')}</th>
                  <th scope="col">{t('columns.status')}</th>
                  <th scope="col">{t('columns.checkIn')}</th>
                  <th scope="col">{t('columns.location')}</th>
                  <th scope="col">{t('guest.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {data.guestSubmissions.map((g) => (
                  <tr key={g.id}>
                    <th scope="row">{g.fullName}</th>
                    <td dir="ltr">{g.seatNumber}</td>
                    <td>
                      <AttendanceBadge status={g.status} minutesLate={g.minutesLate} />
                    </td>
                    <td>{clock(g.submittedAt)}</td>
                    <td>
                      <a
                        href={`https://www.google.com/maps?q=${g.location.latitude},${g.location.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        dir="ltr"
                      >
                        {g.location.latitude.toFixed(5)}, {g.location.longitude.toFixed(5)}
                      </a>
                      <br />
                      <span className="muted small">
                        {g.location.accuracyMeters !== null &&
                          t('accuracy', { meters: Math.round(g.location.accuracyMeters) })}
                        {g.location.accuracyMeters !== null &&
                          g.location.distanceMeters !== null &&
                          ' · '}
                        {g.location.distanceMeters !== null &&
                          t('distance', { meters: Math.round(g.location.distanceMeters) })}
                      </span>
                    </td>
                    <td>
                      {t(`guest.outcomes.${g.outcome}`)}
                      {g.student && (
                        <>
                          <br />
                          <Link href={`/students/${g.student.id}`}>{g.student.fullName}</Link>
                          {g.nameMatches === false && (
                            <span className="badge badge-warn">{t('guest.nameDiffers')}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canExport && (
        <section className="card stack" aria-labelledby="export-title">
          <h2 id="export-title">{t('export.titleVisit')}</h2>
          <ExportForm visitId={v.id} groups={v.groups} back={here} error={exportError} />
        </section>
      )}
    </div>
  );
}
