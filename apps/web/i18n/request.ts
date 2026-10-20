import { APP_TIMEZONE, LOCALE_COOKIE } from '@ftms/core';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { intlLocale, resolveLocale } from './locale';

/**
 * Locale comes from the `NEXT_LOCALE` cookie (no locale prefix in URLs). It is
 * set by the language switcher and, at sign-in, from the account's saved
 * preference. Dates always display in Africa/Cairo (§16.2).
 */
export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const messages = (await import(`../messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  return {
    locale: intlLocale(locale),
    messages: messages.default,
    timeZone: APP_TIMEZONE,
  };
});
