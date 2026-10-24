import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  type GroupSwapView,
  ListGroupSwapsQuerySchema,
  type ListGroupSwapsResponse,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SwapStatusBadge } from '@/components/request-status';
import { SwapFilters } from '@/components/swap-filters';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('groupSwaps'))('title') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/**
 * Group-swap requests (§14.5). Faculty: the review queue, oldest waiting first.
 * Students: the requests they made or were asked to join.
 */
export default async function GroupSwapsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  if (user.role === 'STUDENT') {
    const own = await apiFetch<GroupSwapView[]>('/me/group-swaps', { accessToken: token });
    return (
      <div className="stack-lg">
        <h1>{t('groupSwaps.mineTitle')}</h1>
        <section className="card stack" aria-labelledby="mine">
          <h2 id="mine" className="sr-only">
            {t('groupSwaps.mineTitle')}
          </h2>
          {!own.ok ? (
            <p className="alert alert-error">{t('groupSwaps.loadFailed')}</p>
          ) : own.data.length === 0 ? (
            <p className="empty">{t('groupSwaps.emptyMine')}</p>
          ) : (
            <ul className="agenda">
              {own.data.map((s) => (
                <li key={s.id}>
                  <Link href={`/group-swaps/${s.id}`}>
                    <strong>
                      {s.role === 'REQUESTER'
                        ? t('groupSwaps.withStudent', { name: s.counterpart.fullName })
                        : t('groupSwaps.fromStudent', {
                            name: s.requester.fullName,
                            seat: s.requester.seatNumber,
                          })}
                    </strong>
                  </Link>{' '}
                  <SwapStatusBadge status={s.status} />
                  <p className="muted small">{date(s.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link href="/tickets?new=1">{t('groupSwaps.newRequest')}</Link>
          </p>
        </section>
      </div>
    );
  }

  const canDecide = user.permissions.includes('group_swaps.decide');
  const canAudit = user.permissions.includes('group_swaps.audit');
  if (!canDecide && !canAudit) notFound();
  const raw = await searchParams;
  const parsed = ListGroupSwapsQuerySchema.safeParse({
    status:
      param(raw, 'status') === 'all'
        ? undefined
        : (param(raw, 'status') ?? (canDecide ? 'PENDING_FACULTY' : undefined)),
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
  const result = await apiFetch<ListGroupSwapsResponse>(`/group-swaps?${params}`, {
    accessToken: token,
  });
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    if (!query.status) next.set('status', 'all');
    next.set('page', String(page));
    return `/group-swaps?${next.toString()}`;
  };

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1>{t('groupSwaps.title')}</h1>
        {canAudit && (
          <Link className="btn btn-secondary" href="/group-swaps/history">
            {t('groupSwaps.historyTitle')}
          </Link>
        )}
      </div>
      <SwapFilters action="/group-swaps" query={query} />
      <section className="card stack" aria-labelledby="queue-title">
        <h2 id="queue-title" className="sr-only">
          {t('groupSwaps.title')}
        </h2>
        {!result.ok ? (
          <p className="alert alert-error" role="alert">
            {t('groupSwaps.loadFailed')}
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="empty">{t('groupSwaps.empty')}</p>
        ) : (
          <>
            <p className="muted small" role="status">
              {t('groupSwaps.count', { count: result.data.total })}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('groupSwaps.columns.request')}</th>
                    <th scope="col">{t('groupSwaps.parties.requester')}</th>
                    <th scope="col">{t('groupSwaps.parties.counterpart')}</th>
                    <th scope="col">{t('groupSwaps.columns.status')}</th>
                    <th scope="col">{t('groupSwaps.columns.created')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link href={`/group-swaps/${s.id}`} dir="ltr">
                          #{s.ticketNumber}
                        </Link>
                      </td>
                      <td>
                        {s.requester.fullName}
                        <br />
                        <span className="muted small">
                          <span dir="ltr">{s.requester.seatNumber}</span> · {s.requester.group.name}
                        </span>
                      </td>
                      <td>
                        {s.counterpart.fullName}
                        <br />
                        <span className="muted small">
                          <span dir="ltr">{s.counterpart.seatNumber}</span> ·{' '}
                          {s.counterpart.group.name}
                        </span>
                      </td>
                      <td>
                        <SwapStatusBadge status={s.status} />
                        {s.stale && <span className="badge">{t('groupSwaps.changed')}</span>}
                      </td>
                      <td>{date(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {result.ok && pages > 1 && (
          <nav className="pagination" aria-label={t('common.pageOf', { page: query.page, pages })}>
            {query.page > 1 && <Link href={pageHref(query.page - 1)}>{t('common.previous')}</Link>}
            <span>{t('common.pageOf', { page: query.page, pages })}</span>
            {query.page < pages && <Link href={pageHref(query.page + 1)}>{t('common.next')}</Link>}
          </nav>
        )}
      </section>
    </div>
  );
}
