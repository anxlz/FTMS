'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * A page that failed to render (§18.3): says so plainly, offers to try again,
 * and shows a reference the support team can find in the server logs — never
 * the error itself, which may contain internals.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // The details stay in the server log, under the same reference.
  const t = useTranslations('errorPage');
  return (
    <section className="card stack" role="alert" aria-labelledby="error-title">
      <h1 id="error-title">{t('errorTitle')}</h1>
      <p>{t('errorText')}</p>
      {error.digest && (
        <p className="muted small">
          {t('reference')} <span dir="ltr">{error.digest}</span>
        </p>
      )}
      <p className="actions">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          {t('retry')}
        </button>
        <Link className="btn btn-secondary" href="/dashboard">
          {t('dashboard')}
        </Link>
      </p>
    </section>
  );
}
