'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type NavItem } from '@/lib/navigation';

/**
 * Shown beside a navigation link while its page loads (§18.3). A route-level
 * loading boundary would do the same, but it would also turn every 404 into a
 * streamed 200 — and the API's "not found" for records a reader may not see
 * must stay a real 404.
 */
function Pending() {
  const { pending } = useLinkStatus();
  const t = useTranslations('errorPage');
  if (!pending) return null;
  return <span className="spinner spinner-small" role="status" aria-label={t('loading')} />;
}

export function SideNav({ items, label }: { items: NavItem[]; label: string }) {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="side-nav" aria-label={label}>
      <ul>
        {items.map((item) =>
          item.href ? (
            <li key={item.key}>
              <Link
                href={item.href}
                className="nav-link"
                aria-current={
                  pathname === item.href || pathname.startsWith(`${item.href}/`)
                    ? 'page'
                    : undefined
                }
              >
                {t(`nav.${item.key}`)}
                <Pending />
              </Link>
            </li>
          ) : (
            <li key={item.key}>
              <span className="nav-link nav-link-disabled" aria-disabled="true">
                {t(`nav.${item.key}`)}
                <span className="nav-soon">
                  {t('common.comingSoon')} · {t('common.phase', { n: item.phase ?? 0 })}
                </span>
              </span>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
