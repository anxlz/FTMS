import { type SettingsChange } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { showValue } from '@/lib/display';

/** Configuration history (§11.3): who changed which setting, when, from what to what. */
export async function SettingsHistory({ entries }: { entries: SettingsChange[] }) {
  const t = await getTranslations();
  const format = await getFormatter();
  return (
    <ol className="history">
      {entries.map((h, i) => (
        <li key={`${h.at}-${i}`}>
          <p>
            <strong>
              {t.has(`schedule.actions.${h.action}`) ? t(`schedule.actions.${h.action}`) : h.action}
            </strong>{' '}
            <span className="muted small">
              {format.dateTime(new Date(h.at), { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
              {h.actorName ?? '—'}
            </span>
          </p>
          {h.reason && <p className="small">{t('visits.historyReason', { reason: h.reason })}</p>}
          <ul className="changes">
            {Object.keys(h.after ?? {}).map((key) => (
              <li key={key}>
                {t.has(`schedule.fields.${key}`) ? t(`schedule.fields.${key}`) : key}:{' '}
                {h.before && <del>{showValue(h.before[key])}</del>}
                {h.before && ' → '}
                <ins>{showValue(h.after?.[key])}</ins>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
