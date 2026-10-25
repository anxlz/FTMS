'use client';

import { useTranslations } from 'next-intl';
import { useInApp } from '@/lib/use-in-app';
import { QrScan } from './qr-scan';

/**
 * In the Android app (Phase 8), a signed-in student's shortcut to scan a visit's
 * QR code. In a browser the phone's own camera app opens the printed link, so
 * nothing is shown. Biometric login is never needed to check in.
 */
export function AppCheckIn() {
  const t = useTranslations('scan');
  const app = useInApp();
  if (!app) return null;
  return (
    <section className="card stack" aria-labelledby="scan-title">
      <h2 id="scan-title">{t('title')}</h2>
      <p className="muted small">{t('signedInIntro')}</p>
      <QrScan mode="signed-in" compact />
    </section>
  );
}
