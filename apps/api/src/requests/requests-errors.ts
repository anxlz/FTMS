import { type GroupSwapStatus } from '@ftms/core';
import { ApiException } from '../common/api-exception';

/** Expected failures of tickets and group swaps (see @ftms/core codes). */
export const RequestErrors = {
  ticketClosed: () =>
    new ApiException(409, 'TICKET_CLOSED', 'This ticket is closed; it must be reopened first'),
  managedBySwap: () =>
    new ApiException(
      409,
      'TICKET_MANAGED_BY_SWAP',
      'The status of a group-swap ticket follows its request',
    ),
  noGroup: () => new ApiException(409, 'SWAP_NO_GROUP', 'You are not in a group yet'),
  sameGroup: () =>
    new ApiException(400, 'SWAP_SAME_GROUP', 'Choose a group other than your own', {
      details: { targetGroupId: ['SWAP_SAME_GROUP'] },
    }),
  self: () =>
    new ApiException(400, 'SWAP_SELF', 'You cannot swap with yourself', {
      details: { counterpartSeatNumber: ['SWAP_SELF'] },
    }),
  /**
   * One answer for an unknown seat number, a student of another group, a name
   * that does not match and a student without an account: nothing about other
   * students is revealed beyond what the requester already typed.
   */
  counterpartNotFound: () =>
    new ApiException(
      400,
      'SWAP_COUNTERPART_NOT_FOUND',
      'No student with this seat number (and name) can take part from that group',
      { details: { counterpartSeatNumber: ['SWAP_COUNTERPART_NOT_FOUND'] } },
    ),
  conflict: () =>
    new ApiException(
      409,
      'SWAP_CONFLICT',
      'One of the two students already takes part in an open group-swap request',
    ),
  notAllowed: (status: GroupSwapStatus) =>
    new ApiException(409, 'SWAP_NOT_ALLOWED', `Not possible while the request is ${status}`, {
      details: { status: [status] },
    }),
  stale: () =>
    new ApiException(
      409,
      'SWAP_STALE',
      'A student changed group since the request was made; the request was closed',
    ),
};
