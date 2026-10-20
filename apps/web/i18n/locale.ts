import { DEFAULT_LOCALE, isLocale, type Locale, localeDirection } from '@ftms/core';

export { localeDirection };
export type { Locale };

/** Picks a supported locale, falling back to Arabic (§18.1). */
export const resolveLocale = (value: string | undefined | null): Locale =>
  isLocale(value) ? value : DEFAULT_LOCALE;

/**
 * Intl tag used for formatting. Arabic keeps Arabic grammar and plural rules but
 * formats with Western digits (0–9), as required in both languages (§18.1).
 */
export const intlLocale = (locale: Locale): string => (locale === 'ar' ? 'ar-u-nu-latn' : 'en');
