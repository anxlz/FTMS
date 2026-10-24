import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type TicketActor, type TicketAttachment, type TicketDetail } from '@ftms/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import { SwapStatusBadge, TicketStatusBadge } from '@/components/request-status';
import { apiFetch } from '@/lib/api';
import { accessToken, requireUser } from '@/lib/auth/session';
import { ReplyForm, StatusForm } from '../ticket-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tickets'))('detailTitle') };
}

/**
 * One ticket (§13.2–§13.4): what was asked, the conversation, the outcome and
 * the status history. Students never see which staff member answered or
 * decided — the API sends staff to them without a name.
 */
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const raw = await searchParams;
  const result = await apiFetch<TicketDetail>(`/tickets/${encodeURIComponent(id)}`, {
    accessToken: await accessToken(),
  });
  if (!result.ok) notFound();
  const ticket = result.data;
  const t = await getTranslations();
  const format = await getFormatter();
  const staff = user.role !== 'STUDENT';
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const who = (a: TicketActor) =>
    a.kind === 'SYSTEM'
      ? t('tickets.authors.SYSTEM')
      : (a.name ?? t(`tickets.authors.${a.kind === 'STAFF' ? 'STAFF' : 'STUDENT'}`));
  const files = (list: TicketAttachment[]) =>
    list.length > 0 && (
      <ul className="file-list">
        {list.map((f) => (
          <li key={f.id}>
            <a href={f.url} download={f.fileName}>
              {f.fileName}
            </a>{' '}
            <span className="muted small">
              ({format.number(f.sizeBytes / 1024, { maximumFractionDigits: 0 })} KB)
            </span>
          </li>
        ))}
      </ul>
    );
  const swap = ticket.swap;

  return (
    <div className="stack-lg">
      <p>
        <Link href="/tickets">← {t('tickets.back')}</Link>
      </p>
      {raw.notice === 'created' && (
        <p className="alert alert-success" role="status">
          {t('tickets.created', { number: ticket.number })}
        </p>
      )}
      <div className="row-between">
        <h1>
          <span className="muted" dir="ltr">
            #{ticket.number}
          </span>{' '}
          {ticket.subject}
        </h1>
        {ticket.swapStatus ? (
          <SwapStatusBadge status={ticket.swapStatus} />
        ) : (
          <TicketStatusBadge status={ticket.status} />
        )}
      </div>

      <section className="card" aria-labelledby="about-title">
        <h2 id="about-title" className="sr-only">
          {t('tickets.detailTitle')}
        </h2>
        <dl className="details">
          <div>
            <dt>{t('tickets.fields.category')}</dt>
            <dd>{t(`tickets.categories.${ticket.category}`)}</dd>
          </div>
          <div>
            <dt>{t('tickets.fields.status')}</dt>
            <dd>{t(`tickets.status.${ticket.status}`)}</dd>
          </div>
          <div>
            <dt>{t('tickets.columns.created')}</dt>
            <dd>{date(ticket.createdAt)}</dd>
          </div>
          <div>
            <dt>{t('tickets.columns.activity')}</dt>
            <dd>{date(ticket.lastActivityAt)}</dd>
          </div>
          {staff && ticket.student && (
            <div>
              <dt>{t('tickets.columns.student')}</dt>
              <dd>
                {ticket.student.fullName} · <span dir="ltr">{ticket.student.seatNumber}</span>
                {ticket.student.group && ` · ${ticket.student.group.name}`}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {swap && (
        <section className="card stack" aria-labelledby="swap-title">
          <div className="row-between">
            <h2 id="swap-title">{t('groupSwaps.requestTitle')}</h2>
            <Link href={`/group-swaps/${swap.id}`}>{t('groupSwaps.open')}</Link>
          </div>
          <p>
            {t('groupSwaps.exchangeSummary', {
              requester: swap.requester.fullName,
              requesterGroup: swap.requester.group.name,
              counterpart: swap.counterpart.fullName,
              counterpartGroup: swap.counterpart.group.name,
            })}
          </p>
          <p className="small">{t(`groupSwaps.outcome.${swap.status}`)}</p>
          {swap.rejectionReason && (
            <p className="alert alert-error">
              {t('groupSwaps.reason', { reason: swap.rejectionReason })}
            </p>
          )}
          {swap.cancelReason && (
            <p className="muted small">{t(`groupSwaps.cancelReasons.${swap.cancelReason}`)}</p>
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="description-title">
        <h2 id="description-title">{t('tickets.fields.description')}</h2>
        <p className="pre-line">{ticket.description}</p>
        {files(ticket.attachments)}
      </section>

      {ticket.resolution && (
        <section className="card stack" aria-labelledby="outcome-title">
          <h2 id="outcome-title">{t('tickets.fields.outcome')}</h2>
          <p className="pre-line">{ticket.resolution}</p>
        </section>
      )}

      <section className="card stack" aria-labelledby="conversation-title">
        <h2 id="conversation-title">{t('tickets.conversation')}</h2>
        {ticket.messages.length === 0 ? (
          <p className="empty">{t('tickets.noMessages')}</p>
        ) : (
          <ol className="thread">
            {ticket.messages.map((m) => (
              <li
                key={m.id}
                className={`message message-${m.author.kind.toLowerCase()}${m.internal ? ' message-internal' : ''}`}
              >
                <p className="small">
                  <strong>{who(m.author)}</strong>{' '}
                  <span className="muted">· {date(m.createdAt)}</span>
                  {m.internal && <span className="badge">{t('tickets.internalBadge')}</span>}
                </p>
                <p className="pre-line">{m.body}</p>
                {files(m.attachments)}
              </li>
            ))}
          </ol>
        )}
        {ticket.status === 'CLOSED' ? (
          <p className="muted small">{staff ? t('tickets.closedStaff') : t('tickets.closed')}</p>
        ) : (
          <details open={!staff}>
            <summary>{t('tickets.reply')}</summary>
            <ReplyForm id={ticket.id} staff={staff} />
          </details>
        )}
      </section>

      {staff && (
        <section className="card stack" aria-labelledby="process-title">
          <h2 id="process-title">{t('tickets.process')}</h2>
          {ticket.category === 'GROUP_SWAP' ? (
            <p className="muted small">{t('tickets.managedBySwap')}</p>
          ) : (
            <StatusForm id={ticket.id} status={ticket.status} />
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">{t('tickets.history')}</h2>
        <ol className="history">
          {[...ticket.history].reverse().map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <p>
                <strong>
                  {h.from
                    ? t('tickets.changedTo', {
                        from: t(`tickets.status.${h.from}`),
                        to: t(`tickets.status.${h.to}`),
                      })
                    : t('tickets.opened')}
                </strong>{' '}
                <span className="muted small">
                  {date(h.at)} · {who(h.by)}
                </span>
              </p>
              {h.note && <p className="small pre-line">{h.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
