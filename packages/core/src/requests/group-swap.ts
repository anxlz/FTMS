/**
 * The group-swap state machine (§14). A swap needs the counterpart's consent
 * and then a faculty decision; acceptance alone never moves anyone. The same
 * table is enforced by a database trigger.
 *
 *   PENDING_COUNTERPART ──accept──▶ PENDING_FACULTY ──approve──▶ APPROVED
 *          │ reject                       │ reject (reason)
 *          ▼                              ▼
 *   COUNTERPART_REJECTED            FACULTY_REJECTED
 *
 * From either pending state the requester may WITHDRAW, and the system CANCELS
 * a request when either student's group changes before the decision.
 */
export const GROUP_SWAP_STATUSES = [
  'PENDING_COUNTERPART',
  'COUNTERPART_REJECTED',
  'PENDING_FACULTY',
  'FACULTY_REJECTED',
  'APPROVED',
  'WITHDRAWN',
  'CANCELLED',
] as const;
export type GroupSwapStatus = (typeof GROUP_SWAP_STATUSES)[number];

/** A student takes part in at most one open request at a time (§14.2). */
export const OPEN_GROUP_SWAP_STATUSES = ['PENDING_COUNTERPART', 'PENDING_FACULTY'] as const;
export type OpenGroupSwapStatus = (typeof OPEN_GROUP_SWAP_STATUSES)[number];

export const GROUP_SWAP_EVENTS = [
  'COUNTERPART_ACCEPT',
  'COUNTERPART_REJECT',
  'FACULTY_APPROVE',
  'FACULTY_REJECT',
  'WITHDRAW',
  'INVALIDATE',
] as const;
export type GroupSwapEvent = (typeof GROUP_SWAP_EVENTS)[number];

export const GROUP_SWAP_TRANSITIONS: Readonly<
  Record<GroupSwapStatus, Partial<Record<GroupSwapEvent, GroupSwapStatus>>>
> = {
  PENDING_COUNTERPART: {
    COUNTERPART_ACCEPT: 'PENDING_FACULTY',
    COUNTERPART_REJECT: 'COUNTERPART_REJECTED',
    WITHDRAW: 'WITHDRAWN',
    INVALIDATE: 'CANCELLED',
  },
  PENDING_FACULTY: {
    FACULTY_APPROVE: 'APPROVED',
    FACULTY_REJECT: 'FACULTY_REJECTED',
    WITHDRAW: 'WITHDRAWN',
    INVALIDATE: 'CANCELLED',
  },
  COUNTERPART_REJECTED: {},
  FACULTY_REJECTED: {},
  APPROVED: {},
  WITHDRAWN: {},
  CANCELLED: {},
};

/** The status after `event`, or null when the event is not allowed now. */
export const nextGroupSwapStatus = (
  status: GroupSwapStatus,
  event: GroupSwapEvent,
): GroupSwapStatus | null => GROUP_SWAP_TRANSITIONS[status][event] ?? null;

export const isOpenGroupSwap = (status: GroupSwapStatus): status is OpenGroupSwapStatus =>
  (OPEN_GROUP_SWAP_STATUSES as readonly string[]).includes(status);

/**
 * The status a group-swap request gives its ticket (§13.3): waiting for the
 * counterpart = open; with the faculty = in progress; any outcome = closed.
 */
export const ticketStatusOfSwap = (status: GroupSwapStatus): 'OPEN' | 'IN_PROGRESS' | 'CLOSED' =>
  status === 'PENDING_COUNTERPART'
    ? 'OPEN'
    : status === 'PENDING_FACULTY'
      ? 'IN_PROGRESS'
      : 'CLOSED';
