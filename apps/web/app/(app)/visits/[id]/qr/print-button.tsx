'use client';

import { useTranslations } from 'next-intl';

export function PrintButton() {
  const t = useTranslations('qr');
  return (
    <button type="button" className="btn btn-primary no-print" onClick={() => window.print()}>
      {t('print')}
    </button>
  );
}
