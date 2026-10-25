'use client';

import { type LocationRequirement } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { type LocationReading } from '@/lib/device';

/** What the location rule is, before the reading is taken (§7.2 as revised in Phase 8). */
export function LocationRule({ rule }: { rule: LocationRequirement }) {
  const t = useTranslations('location');
  return (
    <ul className="small muted check-in-facts">
      <li>{t('required')}</li>
      {rule.areaEnforced && rule.radiusMeters !== null && (
        <li>{t('radius', { meters: rule.radiusMeters })}</li>
      )}
      {rule.maxAccuracyMeters !== null && (
        <li>{t('accuracy', { meters: rule.maxAccuracyMeters })}</li>
      )}
    </ul>
  );
}

/** The reading just taken, with its reported accuracy. */
export function LocationReadout({ reading }: { reading: LocationReading }) {
  const t = useTranslations('location');
  return (
    <p className="small muted" role="status">
      {reading.accuracy !== null
        ? t('readAccuracy', { meters: Math.round(reading.accuracy) })
        : t('readNoAccuracy')}
    </p>
  );
}

/** Recovery guidance for a location problem, by error code. */
export function LocationHelp({ code }: { code: string }) {
  const t = useTranslations('location.help');
  if (!t.has(code)) return null;
  return <p className="small">{t(code)}</p>;
}
