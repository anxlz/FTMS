import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE } from '@ftms/core';
import { setLocaleAction } from '@/lib/auth/actions';
import { resolveLocale } from '@/i18n/locale';

/** Toggles Arabic/English. A plain form: works without JavaScript too. */
export async function LanguageSwitcher() {
  const current = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations('common');
  const target = current === 'ar' ? 'en' : 'ar';
  return (
    <form action={setLocaleAction}>
      <input type="hidden" name="locale" value={target} />
      <button
        type="submit"
        className="btn btn-ghost"
        lang={target}
        aria-label={`${t('language')}: ${t('switchTo')}`}
      >
        {t('switchTo')}
      </button>
    </form>
  );
}
