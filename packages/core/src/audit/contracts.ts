import { z } from 'zod';
import { ACCOUNT_STATUSES, ROLES } from '../auth/roles';
import { EXPORT_FORMATS } from '../attendance/contracts';
import { LocalDateSchema } from '../scheduling/time';
import { GroupRefSchema } from '../students/contracts';
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_RESOURCE_TYPES } from './catalogue';

const Id = z.uuid();
const IsoDate = z.iso.datetime();
const Page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
};
const DateRange = {
  from: LocalDateSchema.optional(),
  to: LocalDateSchema.optional(),
};
const rangeInOrder = (q: { from?: string; to?: string }) => !q.from || !q.to || q.to >= q.from;

/** Whose actions to show: staff (default view of the log), students, the system, or everyone. */
export const AUDIT_SCOPES = ['staff', 'students', 'system', 'all'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;

/** Audit ids are database sequence numbers, sent as text. */
export const AuditIdSchema = z.string().regex(/^[1-9]\d{0,18}$/);

const AuditFilters = {
  /** Actor name, action, resource id or reason. */
  q: z.string().trim().max(100).optional(),
  /** One account's actions (§15.3 "filter by faculty member"). */
  actor: Id.optional(),
  scope: z.enum(AUDIT_SCOPES).default('all'),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional(),
  resourceId: z.string().trim().min(1).max(64).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  /** Administrative decisions only (§3.2). */
  decisions: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  ...DateRange,
};

export const ListAuditLogsQuerySchema = z
  .object({ ...AuditFilters, ...Page })
  .refine(rangeInOrder, { error: 'END_BEFORE_START', path: ['to'] });
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

export const AUDIT_EXPORT_FORMATS = ['csv', 'xlsx'] as const;

export const AuditExportQuerySchema = z
  .object({
    ...AuditFilters,
    format: z.enum(AUDIT_EXPORT_FORMATS),
    locale: z.enum(['ar', 'en']).default('ar'),
  })
  .refine(rangeInOrder, { error: 'END_BEFORE_START', path: ['to'] });
export type AuditExportQuery = z.infer<typeof AuditExportQuerySchema>;

/** At most this many events per export; narrow the filters for more. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

/** Who acted, as recorded at the time (name and role may have changed since). */
export const AuditActorSchema = z.object({
  id: Id.nullable(),
  name: z.string().nullable(),
  role: z.enum(ROLES).nullable(),
});
export type AuditActorView = z.infer<typeof AuditActorSchema>;

const JsonObject = z.record(z.string(), z.unknown());

export const AuditEntrySchema = z.object({
  id: AuditIdSchema,
  at: IsoDate,
  /** Null for system jobs and anonymous attempts. */
  actor: AuditActorSchema.nullable(),
  action: z.enum(AUDIT_ACTIONS),
  category: z.enum(AUDIT_CATEGORIES),
  resourceType: z.enum(AUDIT_RESOURCE_TYPES),
  resourceId: z.string().nullable(),
  outcome: z.enum(AUDIT_OUTCOMES),
  reason: z.string().nullable(),
  before: JsonObject.nullable(),
  after: JsonObject.nullable(),
  metadata: JsonObject.nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const ListAuditLogsResponseSchema = z.object({
  items: z.array(AuditEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListAuditLogsResponse = z.infer<typeof ListAuditLogsResponseSchema>;

/** A side missing from the JSON had no such field (created or removed). */
export const AuditChangeSchema = z.object({
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  changed: z.boolean(),
});

/**
 * The affected record as it is now (§15.3 "access to the affected record when
 * still available"): whether it still exists, a readable label, and for
 * attendance records the visit they belong to.
 */
export const AuditResourceSchema = z.object({
  type: z.enum(AUDIT_RESOURCE_TYPES),
  id: z.string(),
  exists: z.boolean(),
  label: z.string().nullable(),
  visitId: Id.nullable(),
});
export type AuditResource = z.infer<typeof AuditResourceSchema>;

export const AuditEntryDetailSchema = AuditEntrySchema.extend({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  changes: z.array(AuditChangeSchema),
  resource: AuditResourceSchema.nullable(),
  /** Other events about the same record, newest first (at most 20). */
  related: z.array(AuditEntrySchema),
});
export type AuditEntryDetail = z.infer<typeof AuditEntryDetailSchema>;

/** Values for the log's filter controls. */
export const AuditFacetsResponseSchema = z.object({
  /** Staff accounts (any status), and staff who acted but no longer exist. */
  actors: z.array(
    z.object({
      id: Id,
      name: z.string(),
      role: z.enum(ROLES),
      status: z.enum(ACCOUNT_STATUSES).nullable(),
    }),
  ),
  /** Actions that occur in the log. */
  actions: z.array(z.enum(AUDIT_ACTIONS)),
  resourceTypes: z.array(z.enum(AUDIT_RESOURCE_TYPES)),
});
export type AuditFacetsResponse = z.infer<typeof AuditFacetsResponseSchema>;

/* ─────────────────────────── faculty activity (§15.1) ─────────────────────────── */

export const FacultyActivityQuerySchema = z
  .object({ ...DateRange })
  .refine(rangeInOrder, { error: 'END_BEFORE_START', path: ['to'] });
export type FacultyActivityQuery = z.infer<typeof FacultyActivityQuerySchema>;

export const FacultyActivityRowSchema = z.object({
  actor: z.object({
    id: Id,
    name: z.string(),
    role: z.enum(ROLES),
    status: z.enum(ACCOUNT_STATUSES).nullable(),
  }),
  total: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  categories: z.partialRecord(z.enum(AUDIT_CATEGORIES), z.number().int().nonnegative()),
  /** Latest action in the period. */
  lastActionAt: IsoDate.nullable(),
});
export type FacultyActivityRow = z.infer<typeof FacultyActivityRowSchema>;

export const FacultyActivityResponseSchema = z.object({
  from: LocalDateSchema,
  to: LocalDateSchema,
  rows: z.array(FacultyActivityRowSchema),
  totals: z.object({
    actions: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    activeStaff: z.number().int().nonnegative(),
  }),
});
export type FacultyActivityResponse = z.infer<typeof FacultyActivityResponseSchema>;

/** The default period of the activity summary, in days up to today. */
export const FACULTY_ACTIVITY_DEFAULT_DAYS = 30;

/* ─────────────────────────── training-wide reports ─────────────────────────── */

export const REPORT_KINDS = ['attendance_summary', 'faculty_activity'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Students by their standing against the absence allowance. */
export const ATTENDANCE_STANDINGS = ['over', 'atLimit', 'within'] as const;
export type AttendanceStanding = (typeof ATTENDANCE_STANDINGS)[number];

const SummaryFilters = {
  group: z.union([Id, z.literal('none')]).optional(),
  q: z.string().trim().max(100).optional(),
  standing: z.enum(ATTENDANCE_STANDINGS).optional(),
};

export const AttendanceSummaryQuerySchema = z.object(SummaryFilters);
export type AttendanceSummaryQuery = z.infer<typeof AttendanceSummaryQuerySchema>;

export const AttendanceSummaryRowSchema = z.object({
  studentId: Id,
  fullName: z.string(),
  seatNumber: z.string(),
  group: GroupRefSchema.nullable(),
  /** Finalized records in the current program (cancelled visits excluded). */
  recorded: z.number().int(),
  present: z.number().int(),
  late: z.number().int(),
  absent: z.number().int(),
  lateMinutes: z.number().int(),
  remainingAbsences: z.number().int(),
  standing: z.enum(ATTENDANCE_STANDINGS),
});
export type AttendanceSummaryRow = z.infer<typeof AttendanceSummaryRowSchema>;

export const AttendanceSummaryResponseSchema = z.object({
  /** Null until the training program is configured. */
  allowedAbsences: z.number().int().nullable(),
  rows: z.array(AttendanceSummaryRowSchema),
  totals: z.object({
    students: z.number().int(),
    present: z.number().int(),
    late: z.number().int(),
    absent: z.number().int(),
    over: z.number().int(),
    atLimit: z.number().int(),
  }),
});
export type AttendanceSummaryResponse = z.infer<typeof AttendanceSummaryResponseSchema>;

/** At most this many students per summary report. */
export const ATTENDANCE_SUMMARY_MAX_ROWS = 5_000;

export const ReportExportQuerySchema = z
  .object({
    ...SummaryFilters,
    ...DateRange,
    format: z.enum(EXPORT_FORMATS),
    locale: z.enum(['ar', 'en']).default('ar'),
  })
  .refine(rangeInOrder, { error: 'END_BEFORE_START', path: ['to'] });
export type ReportExportQuery = z.infer<typeof ReportExportQuerySchema>;
