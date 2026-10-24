import { z } from 'zod';
import { SeatNumberSchema } from '../auth/identity';
import { ROLES } from '../auth/roles';
import { LocalDateSchema } from '../scheduling/time';
import { GroupRefSchema } from '../students/contracts';
import { GROUP_SWAP_STATUSES } from './group-swap';

const Id = z.uuid();
const IsoDate = z.iso.datetime();

/** Tidied text: NFC, trimmed, between `min` and `max` characters. */
const Text = (min: number, max: number, code = 'TEXT_REQUIRED') =>
  z
    .string({ error: code })
    .transform((v) => v.normalize('NFC').trim())
    .pipe(z.string().min(min, { error: code }).max(max, { error: 'TEXT_TOO_LONG' }));

const OptionalText = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => v?.normalize('NFC').trim() || undefined)
    .pipe(z.string().max(max, { error: 'TEXT_TOO_LONG' }).optional());

const Page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

/* ─────────────────────────── tickets (§13) ─────────────────────────── */

/** §13.1, in the order the form shows them. */
export const TICKET_CATEGORIES = ['COMPLAINT', 'SUGGESTION', 'GROUP_SWAP'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Created with the ticket form; a group swap is created with its own form (§14.1). */
export const GENERAL_TICKET_CATEGORIES = ['COMPLAINT', 'SUGGESTION'] as const;

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** `ACTIVE` = open or in progress (what still needs the staff). */
export const TICKET_FILTER_STATUSES = [...TICKET_STATUSES, 'ACTIVE'] as const;

export const TICKET_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
/** Uploads pass through the web server (Vercel request limit), like visit files. */
export const TICKET_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const TICKET_FILES_PER_POST = 3;
export const TICKET_MAX_FILES = 10;

/** Multipart fields arrive as text. */
export const CreateTicketRequestSchema = z.object({
  category: z.enum(GENERAL_TICKET_CATEGORIES),
  subject: Text(3, 200, 'SUBJECT_REQUIRED'),
  description: Text(3, 5000, 'DESCRIPTION_REQUIRED'),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequestSchema>;

export const TicketMessageRequestSchema = z.object({
  body: Text(1, 5000, 'MESSAGE_REQUIRED'),
  /** Staff only: a note the student never sees. */
  internal: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type TicketMessageRequest = z.infer<typeof TicketMessageRequestSchema>;

export const UpdateTicketStatusRequestSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  /** Shown to the student as the outcome when resolving or closing. */
  note: OptionalText(1000),
});
export type UpdateTicketStatusRequest = z.infer<typeof UpdateTicketStatusRequestSchema>;

export const ListTicketsQuerySchema = z.object({
  category: z.enum(TICKET_CATEGORIES).optional(),
  status: z.enum(TICKET_FILTER_STATUSES).optional(),
  /** Staff: ticket number, subject, student name or seat number. */
  q: z.string().trim().max(100).optional(),
  ...Page,
});
export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;

/**
 * Who wrote or changed something. A student never learns which staff member
 * it was (§13.3): staff appear as `{ kind: 'STAFF', name: null }` to students.
 */
export const TicketActorSchema = z.object({
  kind: z.enum(['STUDENT', 'STAFF', 'SYSTEM']),
  name: z.string().nullable(),
});
export type TicketActor = z.infer<typeof TicketActorSchema>;

export const TicketAttachmentSchema = z.object({
  id: Id,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  /** Short-lived signed link (§16.3). */
  url: z.string(),
});
export type TicketAttachment = z.infer<typeof TicketAttachmentSchema>;

export const TicketMessageSchema = z.object({
  id: Id,
  author: TicketActorSchema,
  body: z.string(),
  internal: z.boolean(),
  createdAt: IsoDate,
  attachments: z.array(TicketAttachmentSchema),
});
export type TicketMessage = z.infer<typeof TicketMessageSchema>;

export const TicketStatusChangeSchema = z.object({
  at: IsoDate,
  from: z.enum(TICKET_STATUSES).nullable(),
  to: z.enum(TICKET_STATUSES),
  note: z.string().nullable(),
  by: TicketActorSchema,
});
export type TicketStatusChange = z.infer<typeof TicketStatusChangeSchema>;

export const TicketStudentSchema = z.object({
  id: Id,
  fullName: z.string(),
  seatNumber: z.string(),
  group: GroupRefSchema.nullable(),
});

export const TicketSummarySchema = z.object({
  id: Id,
  number: z.number().int(),
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string(),
  status: z.enum(TICKET_STATUSES),
  createdAt: IsoDate,
  lastActivityAt: IsoDate,
  /** Staff views; null in the student's own list. */
  student: TicketStudentSchema.nullable(),
  swapStatus: z.enum(GROUP_SWAP_STATUSES).nullable(),
});
export type TicketSummary = z.infer<typeof TicketSummarySchema>;

export const ListTicketsResponseSchema = z.object({
  items: z.array(TicketSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListTicketsResponse = z.infer<typeof ListTicketsResponseSchema>;

/* ─────────────────────────── group swaps (§14) ─────────────────────────── */

export const CreateGroupSwapRequestSchema = z.object({
  targetGroupId: Id,
  /** The primary identifier of the counterpart (§14.2). */
  counterpartSeatNumber: SeatNumberSchema,
  /** Optional consistency check only. */
  counterpartName: OptionalText(200),
  note: OptionalText(1000),
});
export type CreateGroupSwapRequest = z.infer<typeof CreateGroupSwapRequestSchema>;

/** §14.1: the requester's group and the groups they may ask to move to. */
export const SwapTargetsResponseSchema = z.object({
  current: GroupRefSchema.nullable(),
  targets: z.array(GroupRefSchema),
});
export type SwapTargetsResponse = z.infer<typeof SwapTargetsResponseSchema>;

export const OptionalReasonRequestSchema = z.object({ reason: OptionalText(500) });
export type OptionalReasonRequest = z.infer<typeof OptionalReasonRequestSchema>;

/** Faculty rejection: the reason is mandatory (§14.5) and shown to both students. */
export const RejectGroupSwapRequestSchema = z.object({ reason: Text(3, 500, 'REASON_REQUIRED') });
export type RejectGroupSwapRequest = z.infer<typeof RejectGroupSwapRequestSchema>;

export const GROUP_SWAP_ROLES = ['REQUESTER', 'COUNTERPART'] as const;
export type GroupSwapRole = (typeof GROUP_SWAP_ROLES)[number];

/** A student in a request, with the group they had when it was made. */
export const SwapPartySchema = z.object({
  fullName: z.string(),
  seatNumber: z.string(),
  group: GroupRefSchema,
});

/** Why the system closed a request (status CANCELLED). */
export const GROUP_SWAP_CANCEL_REASONS = ['GROUP_CHANGED'] as const;

/** What a participating student sees: never who decided for the faculty (§13.3). */
export const GroupSwapViewSchema = z.object({
  id: Id,
  ticketId: Id,
  ticketNumber: z.number().int(),
  status: z.enum(GROUP_SWAP_STATUSES),
  /** The reader's part in it (students); null for staff. */
  role: z.enum(GROUP_SWAP_ROLES).nullable(),
  requester: SwapPartySchema,
  counterpart: SwapPartySchema,
  note: z.string().nullable(),
  createdAt: IsoDate,
  counterpartDecidedAt: IsoDate.nullable(),
  facultyDecidedAt: IsoDate.nullable(),
  closedAt: IsoDate.nullable(),
  /** The faculty's mandatory reason, or the counterpart's optional one. */
  rejectionReason: z.string().nullable(),
  cancelReason: z.enum(GROUP_SWAP_CANCEL_REASONS).nullable(),
});
export type GroupSwapView = z.infer<typeof GroupSwapViewSchema>;

const StaffParty = SwapPartySchema.extend({
  studentId: Id,
  currentGroup: GroupRefSchema.nullable(),
});

/** The faculty review view (§14.5): identities, seat numbers, current groups. */
export const GroupSwapStaffViewSchema = GroupSwapViewSchema.extend({
  requester: StaffParty,
  counterpart: StaffParty,
  /** Either student's group changed since the request: it cannot be approved. */
  stale: z.boolean(),
});
export type GroupSwapStaffView = z.infer<typeof GroupSwapStaffViewSchema>;

export const ListGroupSwapsQuerySchema = z.object({
  status: z.enum(GROUP_SWAP_STATUSES).optional(),
  /** Seat number or name of either student. */
  q: z.string().trim().max(100).optional(),
  from: LocalDateSchema.optional(),
  to: LocalDateSchema.optional(),
  ...Page,
});
export type ListGroupSwapsQuery = z.infer<typeof ListGroupSwapsQuerySchema>;

export const ListGroupSwapsResponseSchema = z.object({
  items: z.array(GroupSwapStaffViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListGroupSwapsResponse = z.infer<typeof ListGroupSwapsResponseSchema>;

export const GROUP_SWAP_DECISION_KINDS = ['COUNTERPART', 'FACULTY', 'REQUESTER', 'SYSTEM'] as const;
export const GROUP_SWAP_DECISIONS = [
  'ACCEPTED',
  'REJECTED',
  'APPROVED',
  'WITHDRAWN',
  'CANCELLED',
] as const;

/** One recorded decision with who made it (Training Director audit, §14.7). */
export const GroupSwapDecisionSchema = z.object({
  kind: z.enum(GROUP_SWAP_DECISION_KINDS),
  decision: z.enum(GROUP_SWAP_DECISIONS),
  by: z
    .object({ id: Id.nullable(), name: z.string().nullable(), role: z.enum(ROLES).nullable() })
    .nullable(),
  reason: z.string().nullable(),
  at: IsoDate,
});
export type GroupSwapDecision = z.infer<typeof GroupSwapDecisionSchema>;

export const GroupSwapHistoryEntrySchema = GroupSwapStaffViewSchema.extend({
  decisions: z.array(GroupSwapDecisionSchema),
});
export type GroupSwapHistoryEntry = z.infer<typeof GroupSwapHistoryEntrySchema>;

export const ListGroupSwapHistoryResponseSchema = z.object({
  items: z.array(GroupSwapHistoryEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListGroupSwapHistoryResponse = z.infer<typeof ListGroupSwapHistoryResponseSchema>;

/* ─────────────────────────── ticket detail ─────────────────────────── */

export const TicketDetailSchema = TicketSummarySchema.extend({
  description: z.string(),
  /** Files sent with the ticket itself. */
  attachments: z.array(TicketAttachmentSchema),
  messages: z.array(TicketMessageSchema),
  history: z.array(TicketStatusChangeSchema),
  /** The outcome note of the latest resolve/close. */
  resolution: z.string().nullable(),
  swap: GroupSwapViewSchema.nullable(),
});
export type TicketDetail = z.infer<typeof TicketDetailSchema>;
