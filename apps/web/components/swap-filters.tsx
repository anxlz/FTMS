import { GROUP_SWAP_STATUSES } from '@ftms/core';
import { getTranslations } from 'next-intl/server';

/** Status, search and date filters, shared by the review queue and the audit history. */
export async function SwapFilters({
  action,
  query,
}: {
  action: string;
  query: { status?: string; q?: string; from?: string; to?: string };
}) {
  const t = await getTranslations();
  return (
    <section className="card">
      <form className="filters" role="search" method="get" action={action}>
        <label className="sr-only" htmlFor="swap-q">
          {t('common.search')}
        </label>
        <input
          id="swap-q"
          name="q"
          type="search"
          defaultValue={query.q ?? ''}
          placeholder={t('groupSwaps.searchPlaceholder')}
        />
        <select
          name="status"
          defaultValue={query.status ?? 'all'}
          aria-label={t('groupSwaps.columns.status')}
        >
          <option value="all">{t('groupSwaps.allStatuses')}</option>
          {GROUP_SWAP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`groupSwaps.status.${s}`)}
            </option>
          ))}
        </select>
        <label className="filter-date">
          <span>{t('groupSwaps.from')}</span>
          <input type="date" name="from" defaultValue={query.from ?? ''} />
        </label>
        <label className="filter-date">
          <span>{t('groupSwaps.to')}</span>
          <input type="date" name="to" defaultValue={query.to ?? ''} />
        </label>
        <button type="submit" className="btn btn-secondary">
          {t('groupSwaps.filter')}
        </button>
      </form>
    </section>
  );
}
