import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** The three views of the Training Director's log (§15.3, §3.2). */
export async function AuditTabs({ current }: { current: 'all' | 'decisions' | 'activity' }) {
  const t = await getTranslations('audit.tabs');
  const tabs = [
    { key: 'all', href: '/audit' },
    { key: 'decisions', href: '/audit?decisions=true&scope=all' },
    { key: 'activity', href: '/audit/activity' },
  ] as const;
  return (
    <nav className="tabs" aria-label={t('label')}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          className={`tab${current === tab.key ? ' tab-active' : ''}`}
          aria-current={current === tab.key ? 'page' : undefined}
        >
          {t(tab.key)}
        </Link>
      ))}
    </nav>
  );
}
