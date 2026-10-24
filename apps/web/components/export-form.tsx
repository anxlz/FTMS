import { type GroupRef } from '@ftms/core';
import { getLocale, getTranslations } from 'next-intl/server';

/**
 * Attendance report download (§10.4, §19): a plain GET form, so it works
 * without JavaScript. The API applies the same permissions as the screens.
 */
export async function ExportForm({
  groups,
  visitId,
  back,
  error,
}: {
  groups?: GroupRef[];
  /** Limit the report to one visit (hides the date filters). */
  visitId?: string;
  /** Page to return to if the export is refused. */
  back: string;
  error?: string | null;
}) {
  const t = await getTranslations('attendance.export');
  const ta = await getTranslations('attendance');
  const te = await getTranslations('errors');
  const locale = (await getLocale()).startsWith('ar') ? 'ar' : 'en';
  return (
    <form action="/attendance/export" method="get" className="stack">
      {error && (
        <p className="alert alert-error" role="alert">
          {te.has(error) ? te(error, { minutes: 1 }) : te('INTERNAL_ERROR')}
        </p>
      )}
      <input type="hidden" name="back" value={back} />
      {visitId && <input type="hidden" name="visit" value={visitId} />}
      <div className="filters">
        <label className="sr-only" htmlFor="export-format">
          {t('format')}
        </label>
        <select id="export-format" name="format" defaultValue="xlsx">
          <option value="xlsx">{t('xlsx')}</option>
          <option value="csv">{t('csv')}</option>
          <option value="pdf">{t('pdf')}</option>
        </select>
        <label className="sr-only" htmlFor="export-locale">
          {t('language')}
        </label>
        <select id="export-locale" name="locale" defaultValue={locale}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
        <label className="sr-only" htmlFor="export-status">
          {t('status')}
        </label>
        <select id="export-status" name="status" defaultValue="">
          <option value="">{t('anyStatus')}</option>
          {(['PRESENT', 'LATE', 'ABSENT'] as const).map((s) => (
            <option key={s} value={s}>
              {ta(`status.${s}`)}
            </option>
          ))}
        </select>
        {groups && (
          <>
            <label className="sr-only" htmlFor="export-group">
              {t('group')}
            </label>
            <select id="export-group" name="group" defaultValue="">
              <option value="">{t('anyGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {!visitId && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="export-from">{t('from')}</label>
            <div className="field-control">
              <input id="export-from" type="date" name="from" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="export-to">{t('to')}</label>
            <div className="field-control">
              <input id="export-to" type="date" name="to" />
            </div>
          </div>
        </div>
      )}
      <p className="muted small">{t('hint')}</p>
      <p>
        <button type="submit" className="btn btn-secondary">
          {t('download')}
        </button>
      </p>
    </form>
  );
}
