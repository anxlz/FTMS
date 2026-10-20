import Image from 'next/image';
import { getTranslations } from 'next-intl/server';

/** Emblem + system name, used in the app header and on sign-in pages. */
export async function Brand({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations('common');
  return (
    <div className={`brand${compact ? ' brand-compact' : ''}`}>
      <Image
        src="/icons/icon-192.png"
        alt=""
        width={compact ? 36 : 56}
        height={compact ? 36 : 56}
        priority
      />
      <div>
        <p className="brand-name">{t('appName')}</p>
        <p className="brand-institution">{t('institution')}</p>
      </div>
    </div>
  );
}
