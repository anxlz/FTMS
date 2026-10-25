import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Brand } from '@/components/brand';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('errorPage'))('notFoundTitle') };
}

/**
 * Unknown pages, and records the reader may not see (the API answers 404 for
 * both, so this page never confirms that something exists).
 */
export default async function NotFound() {
  const t = await getTranslations('errorPage');
  return (
    <main id="main" className="status-page">
      <Brand />
      <h1>{t('notFoundTitle')}</h1>
      <p className="muted">{t('notFoundText')}</p>
      <p>
        <Link className="btn btn-primary" href="/">
          {t('home')}
        </Link>
      </p>
    </main>
  );
}
