import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type Group, type ProgramState, type Schedule } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';
import { dateOfWeekday, dayValue, WEEK_ORDER } from '@/lib/calendar';
import { EndScheduleForm, ScheduleForm } from '../schedule-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schedule'))('editSchedule') };
}

/** One recurring schedule: change it (future sessions only) or end it. */
export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('schedule.manage', 'schedule.group.manage');
  const { id } = await params;
  const t = await getTranslations('schedule');
  const format = await getFormatter();
  const token = await accessToken();
  const [schedules, program, groups] = await Promise.all([
    apiFetch<Schedule[]>('/schedules?includeEnded=true', { accessToken: token }),
    apiFetch<ProgramState>('/program', { accessToken: token }),
    apiFetch<Group[]>('/groups', { accessToken: token }),
  ]);
  const schedule = schedules.ok ? schedules.data.find((s) => s.id === id) : undefined;
  if (!schedule || !program.ok || !program.data.program) notFound();
  const weekdayNames = WEEK_ORDER.map((day) => ({
    day,
    label: format.dateTime(dayValue(dateOfWeekday(day)), { weekday: 'long' }),
  }));
  const options = groups.ok ? groups.data.map((g) => ({ id: g.id, name: g.name })) : [];
  // Groups of the schedule that are now archived stay listed so they can be removed.
  for (const g of schedule.groups) if (!options.some((o) => o.id === g.id)) options.push(g);

  return (
    <div className="stack-lg">
      <p>
        <Link href="/schedule">← {t('title')}</Link>
      </p>
      <h1>{schedule.title}</h1>
      {schedule.endedAt ? (
        <p className="alert alert-info">
          {t('endedOn', {
            date: format.dateTime(new Date(schedule.endedAt), { dateStyle: 'medium' }),
            reason: schedule.endReason ?? '—',
          })}
        </p>
      ) : (
        <>
          <section className="card">
            <ScheduleForm
              schedule={schedule}
              groups={options}
              weekdayNames={weekdayNames}
              program={program.data.program}
            />
          </section>
          <section className="card danger-zone" aria-labelledby="end-title">
            <h2 id="end-title">{t('end')}</h2>
            <EndScheduleForm id={schedule.id} />
          </section>
        </>
      )}
      <p>
        <Link href="/calendar">{t('seeCalendar')}</Link>
      </p>
    </div>
  );
}
