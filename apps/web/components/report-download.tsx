import { getLocale, getTranslations } from 'next-intl/server';

/**
 * A report download (§15, §19): a plain GET form, so it works without
 * JavaScript. The current filters ride along as hidden fields; the API
 * applies the caller's permissions and records the export.
 */
export async function ReportDownload({
  report,
  formats,
  params,
  back,
  error,
  label,
}: {
  report: 'audit' | 'attendance-summary' | 'faculty-activity';
  formats: readonly ('xlsx' | 'csv' | 'pdf')[];
  /** Filters to apply to the file (empty values are left out). */
  params: Record<string, string | undefined>;
  /** Page to return to if the export is refused. */
  back: string;
  error?: string | null;
  label?: string;
}) {
  const t = await getTranslations('reports.download');
  const te = await getTranslations('errors');
  const locale = (await getLocale()).startsWith('ar') ? 'ar' : 'en';
  const id = `dl-${report}`;
  return (
    <form action="/reports/download" method="get" className="stack">
      {error && (
        <p className="alert alert-error" role="alert">
          {te.has(error) ? te(error, { minutes: 1 }) : te('INTERNAL_ERROR')}
        </p>
      )}
      <input type="hidden" name="report" value={report} />
      <input type="hidden" name="back" value={back} />
      {Object.entries(params)
        .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      <div className="filters">
        <label className="sr-only" htmlFor={`${id}-format`}>
          {t('format')}
        </label>
        <select id={`${id}-format`} name="format" defaultValue={formats[0]}>
          {formats.map((f) => (
            <option key={f} value={f}>
              {t(`formats.${f}`)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`${id}-locale`}>
          {t('language')}
        </label>
        <select id={`${id}-locale`} name="locale" defaultValue={locale}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
        <button type="submit" className="btn btn-secondary">
          {label ?? t('submit')}
        </button>
      </div>
    </form>
  );
}
