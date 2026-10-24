import { type GroupSwapStatus, type TicketStatus } from '@ftms/core';
import { getTranslations } from 'next-intl/server';

/** Ticket status with a marker shape as well as a color (§18.3). */
export async function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const t = await getTranslations('tickets.status');
  return <span className={`status status-tk-${status.toLowerCase()}`}>{t(status)}</span>;
}

/** Group-swap status (§14), worded for whoever reads it. */
export async function SwapStatusBadge({ status }: { status: GroupSwapStatus }) {
  const t = await getTranslations('groupSwaps.status');
  return <span className={`status status-sw-${status.toLowerCase()}`}>{t(status)}</span>;
}
