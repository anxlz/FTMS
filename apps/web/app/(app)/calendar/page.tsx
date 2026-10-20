import type { Metadata } from 'next';
import { type CalendarResponse, type Group, PROGRAM_TIME_ZONE, todayIn } from '@ftms/core';
import { getTranslations } from 'next-intl/server';
import { MonthCalendar } from '@/components/month-calendar';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { firstDayOf, lastDayOf, parseMonth } from '@/lib/calendar';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('calendar'))('title') };
}

/**
 * Students: the visits of their current group only (§9.4). Staff: every visit,
 * optionally one group's (§6.2). The API decides what each account may see.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const t = await getTranslations('calendar');
  const raw = await searchParams;
  const today = todayIn(PROGRAM_TIME_ZONE);
  const month = parseMonth(typeof raw.month === 'string' ? raw.month : undefined, today);
  const isStudent = user.role === 'STUDENT';
  const group = !isStudent && typeof raw.group === 'string' ? raw.group : '';
  const token = await accessToken();

  const [calendar, groups] = await Promise.all([
    apiFetch<CalendarResponse>(
      `/calendar?from=${firstDayOf(month)}&to=${lastDayOf(month)}${group ? `&group=${encodeURIComponent(group)}` : ''}`,
      { accessToken: token },
    ),
    isStudent ? null : apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);

  return (
    <div className="stack-lg">
      <h1>{isStudent ? t('studentTitle') : t('title')}</h1>
      {isStudent && calendar.ok && (
        <p className={calendar.data.group ? 'muted' : 'alert alert-info'}>
          {calendar.data.group ? t('yourGroup', { name: calendar.data.group.name }) : t('noGroup')}
        </p>
      )}
      {groups?.ok && (
        <form className="filters" method="get">
          <input type="hidden" name="month" value={month} />
          <label htmlFor="calendar-group">{t('group')}</label>
          <select id="calendar-group" name="group" defaultValue={group}>
            <option value="">{t('allGroups')}</option>
            {groups.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary">
            {t('show')}
          </button>
        </form>
      )}
      {calendar.ok ? (
        <section className="card">
          <MonthCalendar
            month={month}
            today={today}
            visits={calendar.data.visits}
            query={group ? `group=${encodeURIComponent(group)}` : ''}
            showGroups={!isStudent}
          />
        </section>
      ) : (
        <p className="alert alert-error">{t('loadError')}</p>
      )}
    </div>
  );
}
