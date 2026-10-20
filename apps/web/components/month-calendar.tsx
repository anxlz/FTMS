import { type LocalDate, type VisitSummary } from '@ftms/core';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  dateOfWeekday,
  dayValue,
  firstDayOf,
  type Month,
  monthGrid,
  shiftMonth,
  WEEK_ORDER,
} from '@/lib/calendar';

/** Status in words and a marker shape, never by color alone (§9.1). */
export async function VisitStatus({ visit }: { visit: Pick<VisitSummary, 'status' | 'phase'> }) {
  const t = await getTranslations('visits');
  if (visit.status === 'CANCELLED') {
    return <span className="status status-cancelled">{t('status.CANCELLED')}</span>;
  }
  return (
    <span className={`status status-phase-${visit.phase.toLowerCase()}`}>
      {t(`phase.${visit.phase}`)}
    </span>
  );
}

export const timeRange = (v: Pick<VisitSummary, 'startTime' | 'endTime'>): string =>
  v.endTime ? `${v.startTime}–${v.endTime}` : v.startTime;

/**
 * Month view (Saturday-first weeks) followed by an agenda list of the same
 * visits — the list reads well on phones and with screen readers.
 */
export async function MonthCalendar({
  month,
  today,
  visits,
  query,
  showGroups,
}: {
  month: Month;
  today: LocalDate;
  visits: VisitSummary[];
  /** Extra query string kept when moving between months (e.g. a group filter). */
  query: string;
  showGroups: boolean;
}) {
  const t = await getTranslations('calendar');
  const format = await getFormatter();
  const byDay = new Map<LocalDate, VisitSummary[]>();
  for (const v of visits) byDay.set(v.date, [...(byDay.get(v.date) ?? []), v]);
  const href = (m: Month) => `?month=${m}${query ? `&${query}` : ''}`;
  const monthName = format.dateTime(dayValue(firstDayOf(month)), {
    month: 'long',
    year: 'numeric',
  });
  const inMonth = (d: LocalDate) => d.startsWith(month);

  return (
    <div className="stack">
      <nav className="row-between" aria-label={t('monthNavigation')}>
        <Link href={href(shiftMonth(month, -1))} className="btn btn-secondary">
          {t('previousMonth')}
        </Link>
        <h2 aria-live="polite">{monthName}</h2>
        <Link href={href(shiftMonth(month, 1))} className="btn btn-secondary">
          {t('nextMonth')}
        </Link>
      </nav>
      <p>
        <Link href={href(today.slice(0, 7))}>{t('thisMonth')}</Link>
      </p>

      <div className="table-wrap">
        <table className="month-grid">
          <caption className="sr-only">{monthName}</caption>
          <thead>
            <tr>
              {WEEK_ORDER.map((w) => (
                <th key={w} scope="col">
                  {format.dateTime(dayValue(dateOfWeekday(w)), { weekday: 'short' })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid(month).map((week) => (
              <tr key={week[0]}>
                {week.map((day) => (
                  <td
                    key={day}
                    className={`${inMonth(day) ? '' : 'day-outside'}${day === today ? ' day-today' : ''}`}
                    aria-current={day === today ? 'date' : undefined}
                  >
                    <span className="day-number">{Number(day.slice(8))}</span>
                    {inMonth(day) && (
                      <ul className="day-visits">
                        {(byDay.get(day) ?? []).map((v) => (
                          <li
                            key={v.id}
                            className={v.status === 'CANCELLED' ? 'visit-cancelled' : undefined}
                          >
                            <Link href={`/visits/${v.id}`}>
                              <span dir="ltr">{v.startTime}</span> {v.title}
                            </Link>
                            {v.status === 'CANCELLED' && (
                              <span className="sr-only"> — {t('cancelled')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="stack" aria-labelledby="agenda-title">
        <h2 id="agenda-title">{t('agenda')}</h2>
        {visits.length === 0 ? (
          <p className="empty">{t('noVisits')}</p>
        ) : (
          <ul className="agenda">
            {visits.map((v) => (
              <li key={v.id} className={v.status === 'CANCELLED' ? 'visit-cancelled' : undefined}>
                <div className="row-between">
                  <Link href={`/visits/${v.id}`}>
                    <strong>{v.title}</strong>
                  </Link>
                  <VisitStatus visit={v} />
                </div>
                <p className="muted small">
                  {format.dateTime(dayValue(v.date), { dateStyle: 'full' })} ·{' '}
                  <span dir="ltr">{timeRange(v)}</span>
                  {v.locationName ? ` · ${v.locationName}` : ''}
                  {showGroups && v.groups.length > 0
                    ? ` · ${format.list(v.groups.map((g) => g.name))}`
                    : ''}
                </p>
                {v.status === 'CANCELLED' && v.cancelReason && (
                  <p className="small">{t('cancelReason', { reason: v.cancelReason })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
