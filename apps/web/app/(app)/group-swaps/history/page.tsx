import type { Metadata } from 'next';
import Link from 'next/link';
import { ListGroupSwapsQuerySchema, type ListGroupSwapHistoryResponse } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SwapStatusBadge } from '@/components/request-status';
import { SwapFilters } from '@/components/swap-filters';
import { apiFetch } from '@/lib/api';
import { accessToken, requirePermission } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('groupSwaps'))('historyTitle') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/**
 * Group-swap audit history (§14.7), for the Training Director: every request
 * with both students, their original groups, each decision and who made it.
 * Separate from what students see, which never names the faculty member.
 */
export default async function GroupSwapHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('group_swaps.audit');
  const t = await getTranslations();
  const format = await getFormatter();
  const raw = await searchParams;
  const parsed = ListGroupSwapsQuerySchema.safeParse({
    status: param(raw, 'status') === 'all' ? undefined : param(raw, 'status'),
    q: param(raw, 'q'),
    from: param(raw, 'from'),
    to: param(raw, 'to'),
    page: param(raw, 'page') ?? 1,
  });
  const query = parsed.success ? parsed.data : ListGroupSwapsQuerySchema.parse({});
  const params = new URLSearchParams(
    Object.entries({
      status: query.status,
      q: query.q,
      from: query.from,
      to: query.to,
      page: String(query.page),
      pageSize: String(query.pageSize),
    }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  );
  const result = await apiFetch<ListGroupSwapHistoryResponse>(`/group-swaps/history?${params}`, {
    accessToken: await accessToken(),
  });
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    return `/group-swaps/history?${next.toString()}`;
  };
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack-lg">
      <p>
        <Link href="/group-swaps">← {t('groupSwaps.back')}</Link>
      </p>
      <h1>{t('groupSwaps.historyTitle')}</h1>
      <p className="muted">{t('groupSwaps.historyHint')}</p>
      <SwapFilters action="/group-swaps/history" query={query} />

      {!result.ok ? (
        <p className="alert alert-error" role="alert">
          {t('groupSwaps.loadFailed')}
        </p>
      ) : result.data.items.length === 0 ? (
        <p className="empty card">{t('groupSwaps.empty')}</p>
      ) : (
        <>
          <p className="muted small" role="status">
            {t('groupSwaps.count', { count: result.data.total })}
          </p>
          <ol className="audit-list">
            {result.data.items.map((s) => (
              <li key={s.id} className="card stack">
                <div className="row-between">
                  <h2 className="h3">
                    <Link href={`/group-swaps/${s.id}`}>
                      {t('groupSwaps.requestNumber', { number: s.ticketNumber })}
                    </Link>
                  </h2>
                  <SwapStatusBadge status={s.status} />
                </div>
                <dl className="details">
                  <div>
                    <dt>{t('groupSwaps.requestId')}</dt>
                    <dd className="small" dir="ltr">
                      {s.id}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('groupSwaps.parties.requester')}</dt>
                    <dd>
                      {s.requester.fullName} · <span dir="ltr">{s.requester.seatNumber}</span>
                      <br />
                      <span className="small">
                        {t('groupSwaps.originalGroup', { group: s.requester.group.name })}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('groupSwaps.parties.counterpart')}</dt>
                    <dd>
                      {s.counterpart.fullName} · <span dir="ltr">{s.counterpart.seatNumber}</span>
                      <br />
                      <span className="small">
                        {t('groupSwaps.originalGroup', { group: s.counterpart.group.name })}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('groupSwaps.proposedTarget')}</dt>
                    <dd>{s.counterpart.group.name}</dd>
                  </div>
                  <div>
                    <dt>{t('groupSwaps.columns.created')}</dt>
                    <dd>{date(s.createdAt)}</dd>
                  </div>
                  {s.closedAt && (
                    <div>
                      <dt>{t('groupSwaps.closedAt')}</dt>
                      <dd>{date(s.closedAt)}</dd>
                    </div>
                  )}
                </dl>
                <h3 className="h3">{t('groupSwaps.decisions')}</h3>
                {s.decisions.length === 0 ? (
                  <p className="muted small">{t('groupSwaps.noDecisions')}</p>
                ) : (
                  <ol className="history">
                    {s.decisions.map((d, i) => (
                      <li key={`${d.at}-${i}`}>
                        <p>
                          <strong>
                            {t(`groupSwaps.decisionKinds.${d.kind}`)}:{' '}
                            {t(`groupSwaps.decisionValues.${d.decision}`)}
                          </strong>{' '}
                          <span className="muted small">
                            {date(d.at)} ·{' '}
                            {d.by?.name
                              ? `${d.by.name}${d.by.role ? ` (${t(`roles.${d.by.role}`)})` : ''}`
                              : t('tickets.authors.SYSTEM')}
                          </span>
                        </p>
                        {d.reason && (
                          <p className="small">
                            {d.kind === 'SYSTEM' && d.reason === 'GROUP_CHANGED'
                              ? t('groupSwaps.cancelReasons.GROUP_CHANGED')
                              : t('groupSwaps.reason', { reason: d.reason })}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        </>
      )}

      {result.ok && pages > 1 && (
        <nav className="pagination" aria-label={t('common.pageOf', { page: query.page, pages })}>
          {query.page > 1 && <Link href={pageHref(query.page - 1)}>{t('common.previous')}</Link>}
          <span>{t('common.pageOf', { page: query.page, pages })}</span>
          {query.page < pages && <Link href={pageHref(query.page + 1)}>{t('common.next')}</Link>}
        </nav>
      )}
    </div>
  );
}
