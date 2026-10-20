import type { Metadata } from 'next';
import Link from 'next/link';
import { type ListNotificationsResponse } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { notificationTexts } from '@/lib/notification-text';
import { openNotificationAction } from './actions';
import { MarkAllReadButton, MarkReadButton } from './notification-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('notifications'))('title') };
}

const PAGE_SIZE = 30;

/** The notification center (§6.4, §12): the caller's own notifications only. */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const t = await getTranslations();
  const format = await getFormatter();
  const raw = await searchParams;
  const unreadOnly = raw.unread === 'true';
  const page = Math.max(1, Number(typeof raw.page === 'string' ? raw.page : 1) || 1);
  const result = await apiFetch<ListNotificationsResponse>(
    `/notifications?page=${page}&pageSize=${PAGE_SIZE}${unreadOnly ? '&unread=true' : ''}`,
    { accessToken: await accessToken() },
  );
  if (!result.ok) {
    return <p className="alert alert-error">{t('errors.INTERNAL_ERROR')}</p>;
  }
  const { items, total, unread } = result.data;
  const texts = await notificationTexts(items);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => `?page=${p}${unreadOnly ? '&unread=true' : ''}`;

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1>{t('notifications.title')}</h1>
        {unread > 0 && <MarkAllReadButton />}
      </div>
      <p className="muted">{t('notifications.unreadCount', { count: unread })}</p>
      <nav className="tabs" aria-label={t('notifications.filter')}>
        <Link
          href="/notifications"
          className={`tab${unreadOnly ? '' : ' tab-active'}`}
          aria-current={unreadOnly ? undefined : 'page'}
        >
          {t('notifications.all')}
        </Link>
        <Link
          href="/notifications?unread=true"
          className={`tab${unreadOnly ? ' tab-active' : ''}`}
          aria-current={unreadOnly ? 'page' : undefined}
        >
          {t('notifications.unreadOnly')}
        </Link>
      </nav>

      {items.length === 0 ? (
        <p className="empty card">{t('notifications.empty')}</p>
      ) : (
        <ul className="notification-list">
          {items.map((n, i) => {
            const text = texts[i]!;
            return (
              <li
                key={n.id}
                className={`card notification${n.readAt ? '' : ' notification-unread'}`}
              >
                <div className="row-between">
                  <p className="notification-title">
                    {!n.readAt && <span className="badge">{t('notifications.new')}</span>}{' '}
                    <strong>{text.title}</strong>
                  </p>
                  <span className="muted small">
                    {format.dateTime(new Date(n.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
                {text.body && <p>{text.body}</p>}
                <div className="actions">
                  {n.link && (
                    <form action={openNotificationAction} className="inline-form">
                      <input type="hidden" name="id" value={n.id} />
                      <input type="hidden" name="link" value={n.link} />
                      <button type="submit" className="btn btn-primary">
                        {t('notifications.open')}
                      </button>
                    </form>
                  )}
                  {!n.readAt && <MarkReadButton id={n.id} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label={t('common.pageOf', { page, pages })}>
          {page > 1 && <Link href={pageHref(page - 1)}>{t('common.previous')}</Link>}
          <span>{t('common.pageOf', { page, pages })}</span>
          {page < pages && <Link href={pageHref(page + 1)}>{t('common.next')}</Link>}
        </nav>
      )}
    </div>
  );
}
