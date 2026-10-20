import type { Metadata } from 'next';
import Link from 'next/link';
import {
  addDays,
  type CalendarResponse,
  daysBetween,
  type Group,
  PROGRAM_TIME_ZONE,
  todayIn,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { timeRange, VisitStatus } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dayValue, isLocalDate } from '@/lib/calendar';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('visits'))('title') };
}

/** Visit management (§10.2): every visit in a period, by group and status. */
export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('visits.manage');
  const t = await getTranslations();
  const format = await getFormatter();
  const raw = await searchParams;
  const str = (k: string) => (typeof raw[k] === 'string' ? raw[k] : undefined);
  const today = todayIn(PROGRAM_TIME_ZONE);
  const from = isLocalDate(str('from')) ? str('from')! : today;
  let to = isLocalDate(str('to')) ? str('to')! : addDays(from, 30);
  if (daysBetween(from, to) > 100 || to < from) to = addDays(from, 30);
  const group = str('group') ?? '';
  const status =
    str('status') === 'SCHEDULED' || str('status') === 'CANCELLED' ? str('status')! : '';
  const token = await accessToken();
  const query = new URLSearchParams({
    from,
    to,
    ...(group ? { group } : {}),
    ...(status ? { status } : {}),
  });
  const [visits, groups] = await Promise.all([
    apiFetch<CalendarResponse>(`/calendar?${query.toString()}`, { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1>{t('visits.title')}</h1>
        <Link href="/visits/new" className="btn btn-primary">
          {t('visits.new')}
        </Link>
      </div>

      <form className="filters" method="get" aria-label={t('visits.filters')}>
        <label htmlFor="v-from">{t('visits.from')}</label>
        <input id="v-from" type="date" name="from" defaultValue={from} />
        <label htmlFor="v-to">{t('visits.to')}</label>
        <input id="v-to" type="date" name="to" defaultValue={to} />
        <label htmlFor="v-group">{t('calendar.group')}</label>
        <select id="v-group" name="group" defaultValue={group}>
          <option value="">{t('calendar.allGroups')}</option>
          {groups.ok &&
            groups.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
        </select>
        <label htmlFor="v-status">{t('visits.statusFilter')}</label>
        <select id="v-status" name="status" defaultValue={status}>
          <option value="">{t('visits.anyStatus')}</option>
          <option value="SCHEDULED">{t('visits.status.SCHEDULED')}</option>
          <option value="CANCELLED">{t('visits.status.CANCELLED')}</option>
        </select>
        <button type="submit" className="btn btn-secondary">
          {t('common.search')}
        </button>
      </form>

      <section className="card">
        {!visits.ok ? (
          <p className="alert alert-error">{t('errors.INTERNAL_ERROR')}</p>
        ) : visits.data.visits.length === 0 ? (
          <p className="empty">{t('visits.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('visits.columns.date')}</th>
                  <th scope="col">{t('visits.columns.time')}</th>
                  <th scope="col">{t('visits.columns.title')}</th>
                  <th scope="col">{t('visits.columns.groups')}</th>
                  <th scope="col">{t('visits.columns.status')}</th>
                </tr>
              </thead>
              <tbody>
                {visits.data.visits.map((v) => (
                  <tr key={v.id}>
                    <td>{format.dateTime(dayValue(v.date), { dateStyle: 'medium' })}</td>
                    <td dir="ltr">{timeRange(v)}</td>
                    <td>
                      <Link href={`/visits/${v.id}`}>{v.title}</Link>
                    </td>
                    <td>{format.list(v.groups.map((g) => g.name))}</td>
                    <td>
                      <VisitStatus visit={v} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
