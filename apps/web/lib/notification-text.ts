import 'server-only';
import { type Notification } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { dateOfWeekday, dayValue, isLocalDate } from './calendar';

export interface NotificationText {
  title: string;
  body: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Notifications store a type and parameters (§12); this turns them into text in
 * the reader's language, with dates in Africa/Cairo and Western digits (§18.1).
 */
export async function notificationTexts(items: Notification[]): Promise<NotificationText[]> {
  const t = await getTranslations('notifications.text');
  const format = await getFormatter();
  const day = (v: unknown) =>
    isLocalDate(str(v)) ? format.dateTime(dayValue(str(v)), { dateStyle: 'full' }) : '';
  const clock = (start: unknown, end: unknown) =>
    str(end) ? `${str(start)}–${str(end)}` : str(start);
  const days = (v: unknown) =>
    Array.isArray(v)
      ? format.list(
          v
            .filter((w): w is number => typeof w === 'number')
            .map((w) => format.dateTime(dayValue(dateOfWeekday(w)), { weekday: 'long' })),
        )
      : '';
  const when = (d: Record<string, unknown>) =>
    t('when', { date: day(d.date), time: clock(d.startTime, d.endTime) });
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  const where = (d: Record<string, unknown>) =>
    str(d.locationName) ? t('where', { location: str(d.locationName) }) : '';
  const reason = (d: Record<string, unknown>) =>
    str(d.reason) ? t('reason', { reason: str(d.reason) }) : '';

  return items.map(({ type, data: d }) => {
    const title = str(d.title);
    switch (type) {
      case 'visit.created':
        return { title: t('visitCreated', { title }), body: join(when(d), where(d)) };
      case 'visit.updated': {
        const changes = Array.isArray(d.changes) ? (d.changes as string[]) : [];
        const previous = (d.previous ?? {}) as Record<string, unknown>;
        const moved = changes.includes('date') || changes.includes('time');
        return {
          title: t('visitUpdated', { title }),
          body: join(
            moved ? t('moved', { when: when(d), previous: when(previous) }) : when(d),
            changes.includes('location') ? where(d) || t('locationRemoved') : '',
            changes.includes('timing') ? t('timingChanged') : '',
          ),
        };
      }
      case 'visit.cancelled':
        return { title: t('visitCancelled', { title }), body: join(when(d), reason(d)) };
      case 'visit.restored':
        return { title: t('visitRestored', { title }), body: when(d) };
      case 'visit.removed':
        return { title: t('visitRemoved', { title }), body: when(d) };
      case 'schedule.created':
        return {
          title: t('scheduleCreated', { title }),
          body: t('scheduleBody', {
            days: days(d.weekdays),
            time: clock(d.startTime, d.endTime),
            from: day(d.startsOn),
            to: day(d.endsOn),
          }),
        };
      case 'schedule.updated':
        return {
          title: t('scheduleUpdated', { title }),
          body: t('scheduleBody', {
            days: days(d.weekdays),
            time: clock(d.startTime, d.endTime),
            from: day(d.startsOn),
            to: day(d.endsOn),
          }),
        };
      case 'schedule.ended':
        return {
          title: t('scheduleEnded', { title }),
          body: join(
            reason(d),
            t('sessionsCancelled', { count: typeof d.cancelled === 'number' ? d.cancelled : 0 }),
          ),
        };
      case 'schedule.removed':
        return { title: t('scheduleRemoved', { title }), body: t('scheduleRemovedBody') };
      case 'verification.approved':
        return { title: t('verificationApproved'), body: t('verificationApprovedBody') };
      case 'verification.rejected':
        return { title: t('verificationRejected'), body: reason(d) };
      case 'profile_change.approved':
        return {
          title: t('profileChangeApproved'),
          body: str(d.comment) ? t('comment', { comment: str(d.comment) }) : '',
        };
      case 'profile_change.rejected':
        return { title: t('profileChangeRejected'), body: reason(d) };
    }
  });
}
