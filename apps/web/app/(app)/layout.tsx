import { type UnreadCount } from '@ftms/core';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Brand } from '@/components/brand';
import { LanguageSwitcher } from '@/components/language-switcher';
import { SideNav } from '@/components/side-nav';
import { apiFetch } from '@/lib/api';
import { logoutAction } from '@/lib/auth/actions';
import { accessToken, requireUser } from '@/lib/auth/session';
import { navigationFor } from '@/lib/navigation';

export const dynamic = 'force-dynamic';

/** Shell for every signed-in page: header, role-aware navigation, content. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const t = await getTranslations();
  const unread = await apiFetch<UnreadCount>('/notifications/unread-count', {
    accessToken: await accessToken(),
  });
  const count = unread.ok ? unread.data.unread : 0;
  return (
    <div className="app">
      <header className="app-header">
        <Brand compact />
        <div className="app-header-actions">
          <Link
            href="/notifications"
            className="bell"
            aria-label={t('notifications.bellLabel', { count })}
          >
            <span aria-hidden="true">{t('notifications.title')}</span>
            {count > 0 && (
              <span className="bell-count" aria-hidden="true">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </Link>
          <div className="whoami">
            <span className="whoami-name">{user.displayName}</span>
            <span className="badge">{t(`roles.${user.role}`)}</span>
          </div>
          <LanguageSwitcher />
          <form action={logoutAction}>
            <button type="submit" className="btn btn-ghost">
              {t('common.signOut')}
            </button>
          </form>
        </div>
      </header>
      <div className="app-body">
        <SideNav items={navigationFor(user)} label={t('common.mainNavigation')} />
        <main id="main" className="app-main">
          {children}
        </main>
      </div>
    </div>
  );
}
