import type { Metadata, Viewport } from 'next';
import { BRAND_COLORS } from '@ftms/core';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'نظام إدارة التدريب الميداني | Field Training Management System',
    template: '%s | التدريب الميداني',
  },
  description:
    'نظام إدارة التدريب الميداني — كلية الزراعة، جامعة عين شمس. Field Training Management System — Faculty of Agriculture, Ain Shams University.',
  applicationName: 'FTMS',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: BRAND_COLORS.blue,
  colorScheme: 'light',
};

/**
 * Arabic is the default locale and renders RTL on first load (§18.1). The full
 * `next-intl` setup with the language switcher arrives in Phase 1.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
