import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type GroupSwapStaffView, type GroupSwapView, isOpenGroupSwap } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SwapStatusBadge } from '@/components/request-status';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { CounterpartForms, FacultyForms, WithdrawForm } from '../swap-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('groupSwaps'))('requestTitle') };
}

const NOTICES = ['requested', 'accepted', 'declined', 'withdrawn', 'approved', 'rejected', 'stale'];

/**
 * One group-swap request (§14): the proposed exchange, where it stands, and
 * the step the reader may take. Students never see who decided for the
 * faculty; the faculty see both students' current groups before deciding.
 */
export default async function GroupSwapPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const raw = await searchParams;
  const result = await apiFetch<GroupSwapView | GroupSwapStaffView>(
    `/group-swaps/${encodeURIComponent(id)}`,
    { accessToken: await accessToken() },
  );
  if (!result.ok) notFound();
  const swap = result.data;
  const staffView = 'stale' in swap ? swap : null;
  const t = await getTranslations();
  const format = await getFormatter();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const open = isOpenGroupSwap(swap.status);
  const canDecide = user.permissions.includes('group_swaps.decide');
  const notice = typeof raw.notice === 'string' && NOTICES.includes(raw.notice) ? raw.notice : null;
  const ticketHref =
    swap.role === 'REQUESTER' || (staffView && user.permissions.includes('tickets.process'))
      ? `/tickets/${swap.ticketId}`
      : null;
  const parties = [
    { key: 'requester', party: swap.requester, movesTo: swap.counterpart.group },
    { key: 'counterpart', party: swap.counterpart, movesTo: swap.requester.group },
  ] as const;
  const current = (key: 'requester' | 'counterpart') => staffView?.[key].currentGroup ?? null;

  return (
    <div className="stack-lg">
      <p>
        <Link href={user.role === 'STUDENT' ? '/tickets' : '/group-swaps'}>
          ← {user.role === 'STUDENT' ? t('tickets.back') : t('groupSwaps.back')}
        </Link>
      </p>
      {notice && (
        <p
          className={`alert ${notice === 'stale' ? 'alert-error' : 'alert-success'}`}
          role="status"
        >
          {t(`groupSwaps.notices.${notice}`)}
        </p>
      )}
      <div className="row-between">
        <h1>{t('groupSwaps.requestTitle')}</h1>
        <SwapStatusBadge status={swap.status} />
      </div>
      {swap.role && (
        <p className="muted">
          {swap.role === 'REQUESTER'
            ? t('groupSwaps.youRequested', { name: swap.counterpart.fullName })
            : t('groupSwaps.youWereAsked', { name: swap.requester.fullName })}
        </p>
      )}

      <section className="card stack" aria-labelledby="exchange-title">
        <h2 id="exchange-title">{t('groupSwaps.exchange')}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('groupSwaps.columns.student')}</th>
                <th scope="col">{t('groupSwaps.columns.seat')}</th>
                <th scope="col">{t('groupSwaps.columns.from')}</th>
                <th scope="col">{t('groupSwaps.columns.to')}</th>
                {staffView && <th scope="col">{t('groupSwaps.columns.current')}</th>}
              </tr>
            </thead>
            <tbody>
              {parties.map(({ key, party, movesTo }) => (
                <tr key={key}>
                  <td>
                    {party.fullName}
                    <br />
                    <span className="muted small">{t(`groupSwaps.parties.${key}`)}</span>
                  </td>
                  <td dir="ltr">{party.seatNumber}</td>
                  <td>{party.group.name}</td>
                  <td>{movesTo.name}</td>
                  {staffView && (
                    <td>
                      {current(key)?.name ?? t('groupSwaps.noGroup')}
                      {open && current(key)?.id !== party.group.id && (
                        <span className="badge">{t('groupSwaps.changed')}</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {staffView?.stale && <p className="alert alert-error">{t('groupSwaps.staleWarning')}</p>}
        {open && <p className="muted small">{t('groupSwaps.noChangeUntilApproved')}</p>}
        {swap.note && (
          <div>
            <h3 className="h3">{t('groupSwaps.note')}</h3>
            <p className="pre-line">{swap.note}</p>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="progress-title">
        <h2 id="progress-title">{t('groupSwaps.progress')}</h2>
        <ol className="history">
          <li>
            <p>
              <strong>{t('groupSwaps.steps.submitted')}</strong>{' '}
              <span className="muted small">{date(swap.createdAt)}</span>
            </p>
          </li>
          {swap.counterpartDecidedAt && (
            <li>
              <p>
                <strong>
                  {swap.status === 'COUNTERPART_REJECTED'
                    ? t('groupSwaps.steps.counterpartDeclined')
                    : t('groupSwaps.steps.counterpartAccepted')}
                </strong>{' '}
                <span className="muted small">{date(swap.counterpartDecidedAt)}</span>
              </p>
            </li>
          )}
          {swap.facultyDecidedAt && (
            <li>
              <p>
                <strong>
                  {swap.status === 'APPROVED'
                    ? t('groupSwaps.steps.approved')
                    : t('groupSwaps.steps.rejected')}
                </strong>{' '}
                <span className="muted small">{date(swap.facultyDecidedAt)}</span>
              </p>
            </li>
          )}
          {swap.closedAt && !swap.facultyDecidedAt && swap.status !== 'COUNTERPART_REJECTED' && (
            <li>
              <p>
                <strong>{t(`groupSwaps.status.${swap.status}`)}</strong>{' '}
                <span className="muted small">{date(swap.closedAt)}</span>
              </p>
            </li>
          )}
        </ol>
        <p>{t(`groupSwaps.outcome.${swap.status}`)}</p>
        {swap.rejectionReason && (
          <p className="alert alert-error">
            {t('groupSwaps.reason', { reason: swap.rejectionReason })}
          </p>
        )}
        {swap.cancelReason && (
          <p className="muted small">{t(`groupSwaps.cancelReasons.${swap.cancelReason}`)}</p>
        )}
        {!open && swap.role === 'REQUESTER' && swap.status !== 'APPROVED' && (
          <p className="small">
            <Link href="/tickets?new=1">{t('groupSwaps.newRequest')}</Link>
          </p>
        )}
        {ticketHref && (
          <p className="small">
            <Link href={ticketHref}>
              {t('groupSwaps.openTicket', { number: swap.ticketNumber })}
            </Link>
          </p>
        )}
      </section>

      {swap.role === 'COUNTERPART' && swap.status === 'PENDING_COUNTERPART' && (
        <section className="card stack" aria-labelledby="answer-title">
          <h2 id="answer-title">{t('groupSwaps.yourAnswer')}</h2>
          <p className="muted small">{t('groupSwaps.answerHint')}</p>
          <CounterpartForms id={swap.id} />
        </section>
      )}
      {swap.role === 'REQUESTER' && open && (
        <section className="card stack" aria-labelledby="withdraw-title">
          <h2 id="withdraw-title" className="sr-only">
            {t('groupSwaps.withdraw')}
          </h2>
          <WithdrawForm id={swap.id} />
        </section>
      )}
      {staffView && canDecide && swap.status === 'PENDING_FACULTY' && (
        <section className="card stack" aria-labelledby="decide-title">
          <h2 id="decide-title">{t('groupSwaps.decide')}</h2>
          <p className="muted small">
            {staffView.stale ? t('groupSwaps.staleDecide') : t('groupSwaps.decideHint')}
          </p>
          <FacultyForms id={swap.id} />
        </section>
      )}
      {staffView && canDecide && swap.status === 'PENDING_COUNTERPART' && (
        <p className="alert alert-info">{t('groupSwaps.waitingCounterpart')}</p>
      )}
    </div>
  );
}
