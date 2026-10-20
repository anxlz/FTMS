import type { Metadata, Viewport } from 'next';
import { BRAND_COLORS, LOCALE_COOKIE } from '@ftms/core';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { localeDirection, resolveLocale } from '@/i18n/locale';
// Self-hosted Arabic + Latin typeface (no request to Google at build or run time).
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');
  return {
    title: { default: t('appName'), template: `%s | ${t('appNameShort')}` },
    description: `${t('appName')} — ${t('institution')}`,
    applicationName: 'FTMS',
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: BRAND_COLORS.blue,
  colorScheme: 'light',
};

/** Arabic (RTL) by default; English (LTR) via the switcher (§18.1). */
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations('common');
  return (
    <html lang={locale} dir={localeDirection(locale)}>
      <body>
        <a className="skip-link" href="#main">
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider messages={await getMessages()}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
