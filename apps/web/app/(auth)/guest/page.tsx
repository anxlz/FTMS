import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth-card';
import { QrScan } from '@/components/qr-scan';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('guest'))('title') };
}

/**
 * "Continue as guest" (Phase 8): attendance without an account. The person scans
 * the visit's printed QR code (camera in the Android app, or the phone's camera
 * app / a pasted link in a browser), then fills in the guest form.
 */
export default async function GuestPage() {
  const t = await getTranslations('guest');
  return (
    <AuthCard title={t('title')} intro={t('intro')}>
      <ul className="small guest-facts">
        <li>{t('factNoAccount')}</li>
        <li>{t('factLocation')}</li>
        <li>{t('factNotVerified')}</li>
      </ul>
      <QrScan mode="guest" />
      <p className="muted small">{t('browserHint')}</p>
      <p>
        <Link href="/login">{t('toLogin')}</Link>
      </p>
    </AuthCard>
  );
}
