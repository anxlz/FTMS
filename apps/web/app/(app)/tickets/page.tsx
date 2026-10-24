import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  type GroupSwapView,
  ListTicketsQuerySchema,
  type ListTicketsResponse,
  type SwapTargetsResponse,
  TICKET_CATEGORIES,
  TICKET_FILTER_STATUSES,
} from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SwapStatusBadge, TicketStatusBadge } from '@/components/request-status';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { NewRequestForm } from './ticket-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tickets'))('title') };
}

const param = (raw: Record<string, string | string[] | undefined>, key: string) =>
  typeof raw[key] === 'string' && raw[key] ? raw[key] : undefined;

/**
 * Support tickets (§13). Students: their own tickets and requests, filterable,
 * and the requests other students sent them. Staff: the processing queue.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const isStudent = user.role === 'STUDENT';
  if (!isStudent && !user.permissions.includes('tickets.process')) notFound();
  const t = await getTranslations();
  const format = await getFormatter();
  const token = await accessToken();
  const raw = await searchParams;
  const parsed = ListTicketsQuerySchema.safeParse({
    category: param(raw, 'category'),
    status: param(raw, 'status') ?? (isStudent ? undefined : 'ACTIVE'),
    q: isStudent ? undefined : param(raw, 'q'),
    page: param(raw, 'page') ?? 1,
  });
  const query = parsed.success ? parsed.data : ListTicketsQuerySchema.parse({});
  const params = new URLSearchParams(
    Object.entries({
      category: query.category,
      status: query.status,
      q: query.q,
      page: String(query.page),
      pageSize: String(query.pageSize),
    }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  );
  const [result, swaps, targets] = await Promise.all([
    apiFetch<ListTicketsResponse>(`${isStudent ? '/me/tickets' : '/tickets'}?${params}`, {
      accessToken: token,
    }),
    isStudent ? apiFetch<GroupSwapView[]>('/me/group-swaps', { accessToken: token }) : null,
    isStudent
      ? apiFetch<SwapTargetsResponse>('/me/group-swaps/groups', { accessToken: token })
      : null,
  ]);
  const waiting =
    swaps?.ok === true
      ? swaps.data.filter((s) => s.role === 'COUNTERPART' && s.status === 'PENDING_COUNTERPART')
      : [];
  const pages = result.ok ? Math.max(1, Math.ceil(result.data.total / result.data.pageSize)) : 1;
  const pageHref = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    return `/tickets?${next.toString()}`;
  };
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const openForm = raw.new === '1' || (result.ok && result.data.total === 0 && !query.status);

  return (
    <div className="stack-lg">
      <h1>{isStudent ? t('tickets.title') : t('tickets.queueTitle')}</h1>

      {waiting.length > 0 && (
        <section className="card stack" aria-labelledby="waiting-title">
          <h2 id="waiting-title">{t('tickets.waitingTitle')}</h2>
          <p className="muted small">{t('tickets.waitingHint')}</p>
          <ul className="agenda">
            {waiting.map((s) => (
              <li key={s.id}>
                <Link href={`/group-swaps/${s.id}`}>
                  <strong>
                    {t('groupSwaps.fromStudent', {
                      name: s.requester.fullName,
                      seat: s.requester.seatNumber,
                    })}
                  </strong>
                </Link>
                <p className="muted small">
                  {t('groupSwaps.exchangeLine', {
                    from: s.counterpart.group.name,
                    to: s.requester.group.name,
                  })}{' '}
                  · {date(s.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isStudent && user.studentProfile && (
        <details className="card" open={openForm}>
          <summary>
            <span className="h2">{t('tickets.new')}</span>
          </summary>
          <NewRequestForm
            requester={user.studentProfile}
            swap={targets?.ok ? targets.data : null}
          />
        </details>
      )}

      <section className="card stack" aria-labelledby="tickets-list">
        <h2 id="tickets-list">{isStudent ? t('tickets.mine') : t('tickets.queue')}</h2>
        <form className="filters" role="search" method="get">
          {!isStudent && (
            <>
              <label className="sr-only" htmlFor="q">
                {t('common.search')}
              </label>
              <input
                id="q"
                name="q"
                type="search"
                defaultValue={query.q ?? ''}
                placeholder={t('tickets.searchPlaceholder')}
              />
            </>
          )}
          <select
            name="category"
            defaultValue={query.category ?? ''}
            aria-label={t('tickets.fields.category')}
          >
            <option value="">{t('tickets.allCategories')}</option>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`tickets.categories.${c}`)}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={query.status ?? ''}
            aria-label={t('tickets.fields.status')}
          >
            <option value="">{t('tickets.allStatuses')}</option>
            {TICKET_FILTER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`tickets.filterStatus.${s}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary">
            {t('tickets.filter')}
          </button>
        </form>

        {!result.ok ? (
          <p className="alert alert-error" role="alert">
            {t('tickets.loadFailed')}
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="empty">{t('tickets.empty')}</p>
        ) : (
          <>
            <p className="muted small" role="status">
              {t('tickets.count', { count: result.data.total })}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('tickets.columns.number')}</th>
                    <th scope="col">{t('tickets.columns.subject')}</th>
                    {!isStudent && <th scope="col">{t('tickets.columns.student')}</th>}
                    <th scope="col">{t('tickets.columns.category')}</th>
                    <th scope="col">{t('tickets.columns.status')}</th>
                    <th scope="col">{t('tickets.columns.created')}</th>
                    <th scope="col">{t('tickets.columns.activity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((ticket) => (
                    <tr key={ticket.id}>
                      <td dir="ltr">#{ticket.number}</td>
                      <td>
                        <Link href={`/tickets/${ticket.id}`}>{ticket.subject}</Link>
                      </td>
                      {!isStudent && (
                        <td>
                          {ticket.student ? (
                            <>
                              {ticket.student.fullName}
                              <br />
                              <span className="muted small" dir="ltr">
                                {ticket.student.seatNumber}
                              </span>
                              {ticket.student.group && (
                                <span className="muted small"> · {ticket.student.group.name}</span>
                              )}
                            </>
                          ) : (
                            t('common.none')
                          )}
                        </td>
                      )}
                      <td>{t(`tickets.categories.${ticket.category}`)}</td>
                      <td>
                        {ticket.swapStatus ? (
                          <SwapStatusBadge status={ticket.swapStatus} />
                        ) : (
                          <TicketStatusBadge status={ticket.status} />
                        )}
                      </td>
                      <td>{date(ticket.createdAt)}</td>
                      <td>{date(ticket.lastActivityAt)}</td>
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
