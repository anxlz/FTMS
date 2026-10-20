'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type NavItem } from '@/lib/navigation';

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
