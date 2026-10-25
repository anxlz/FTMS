import { z } from 'zod';
import { CheckInPolicySchema } from '../attendance/policy';
import { GroupRefSchema } from '../students/contracts';
import {
  addDays,
  daysBetween,
  type LocalDate,
  LocalDateSchema,
  LocalTimeSchema,
  minutesOf,
  weekdayOf,
} from './time';

const Id = z.uuid();
const IsoDate = z.iso.datetime();
const ReasonSchema = z.string().trim().min(3).max(500);
const OptionalReason = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v ? v : undefined));
const Text = (max: number) => z.string().trim().max(max);

/* ─────────────────────────── attendance timing (§8.1) ─────────────────────────── */

/**
 * The check-in window of a visit, in minutes relative to its scheduled start:
 * opens `checkInOpensMinutes` before; on time until `graceMinutes` after; closes
 * `checkInClosesMinutes` after. Program defaults are copied into each visit when
 * it is created, so later changes to the defaults never rewrite existing visits.
 */
export const VisitTimingSchema = z
  .object({
    checkInOpensMinutes: z.number().int().min(0).max(240),
    graceMinutes: z.number().int().min(0).max(240),
    checkInClosesMinutes: z.number().int().min(1).max(720),
  })
  .refine((t) => t.graceMinutes <= t.checkInClosesMinutes, {
    error: 'GRACE_AFTER_CLOSE',
    path: ['graceMinutes'],
  });
export type VisitTiming = z.infer<typeof VisitTimingSchema>;

/* ─────────────────────────── training program (§11) ─────────────────────────── */

export const PROGRAM_MAX_WEEKS = 52;

/** The program's time zone (§16.2). Every wall-clock date and time is read in it. */
export const PROGRAM_TIME_ZONE = 'Africa/Cairo';

/**
 * Values the settings form starts from when a program is first configured
 * (§6.1, §8.1, §9.2). They are suggestions only: every value is stored on the
 * program and read from there — nothing in the system assumes them.
 */
export const SUGGESTED_PROGRAM_SETTINGS = {
  durationWeeks: 12,
  allowedAbsences: 2,
  timing: { checkInOpensMinutes: 15, graceMinutes: 15, checkInClosesMinutes: 60 },
  checkInPolicy: { radiusMeters: 500, maxAccuracyMeters: 100 },
} as const;

/** Last day of a program that starts on `startDate` and lasts `weeks` weeks. */
export const programEndDate = (startDate: LocalDate, weeks: number): LocalDate =>
  addDays(startDate, weeks * 7 - 1);

export const ProgramSchema = z.object({
  id: Id,
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  durationWeeks: z.number().int(),
  timeZone: z.string(),
  timing: VisitTimingSchema,
  allowedAbsences: z.number().int(),
  checkInPolicy: CheckInPolicySchema,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Program = z.infer<typeof ProgramSchema>;

export const ProgramStateSchema = z.object({ program: ProgramSchema.nullable() });
export type ProgramState = z.infer<typeof ProgramStateSchema>;

export const CreateProgramRequestSchema = z.object({
  name: Text(200).min(2),
  startDate: LocalDateSchema,
  durationWeeks: z.number().int().min(1).max(PROGRAM_MAX_WEEKS),
  allowedAbsences: z.number().int().min(0).max(100),
  timing: VisitTimingSchema,
  checkInPolicy: CheckInPolicySchema.optional(),
});
export type CreateProgramRequest = z.infer<typeof CreateProgramRequestSchema>;

/**
 * Schedule fields need `schedule.manage`; attendance defaults (timing, absence
 * allowance, check-in policy) need `attendance.settings.defaults`. Each change
 * is audited (§11.3).
 */
export const UpdateProgramRequestSchema = z
  .object({
    name: Text(200).min(2).optional(),
    startDate: LocalDateSchema.optional(),
    durationWeeks: z.number().int().min(1).max(PROGRAM_MAX_WEEKS).optional(),
    allowedAbsences: z.number().int().min(0).max(100).optional(),
    timing: VisitTimingSchema.optional(),
    checkInPolicy: CheckInPolicySchema.optional(),
    reason: OptionalReason,
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.startDate !== undefined ||
      v.durationWeeks !== undefined ||
      v.allowedAbsences !== undefined ||
      v.timing !== undefined ||
      v.checkInPolicy !== undefined,
    { error: 'NOTHING_TO_UPDATE' },
  );
export type UpdateProgramRequest = z.infer<typeof UpdateProgramRequestSchema>;

export const SettingsChangeSchema = z.object({
  at: IsoDate,
  actorName: z.string().nullable(),
  action: z.string(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type SettingsChange = z.infer<typeof SettingsChangeSchema>;

/* ─────────────────────────── recurring schedules (§6.1, §11.2) ─────────────────────────── */

export const WeekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1, { error: 'WEEKDAYS_REQUIRED' })
  .max(7)
  .refine((days) => new Set(days).size === days.length, { error: 'DUPLICATE_WEEKDAY' })
  .transform((days) => [...days].sort((a, b) => a - b));

const GroupIdsSchema = z
  .array(Id)
  .min(1, { error: 'GROUPS_REQUIRED' })
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'DUPLICATE_GROUP' });

const timeRangeOk = (start?: string, end?: string | null) =>
  !start || !end || minutesOf(end) > minutesOf(start);

export const ScheduleSchema = z.object({
  id: Id,
  title: z.string(),
  weekdays: z.array(z.number().int()),
  startTime: z.string(),
  endTime: z.string().nullable(),
  startsOn: z.string(),
  endsOn: z.string(),
  locationName: z.string().nullable(),
  groups: z.array(GroupRefSchema),
  endedAt: IsoDate.nullable(),
  endReason: z.string().nullable(),
  visitCount: z.number().int().nonnegative(),
  upcomingCount: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ListSchedulesQuerySchema = z.object({
  includeEnded: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuerySchema>;

/** What a schedule change did to its sessions. */
export const ScheduleChangeResultSchema = z.object({
  schedule: ScheduleSchema,
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export type ScheduleChangeResult = z.infer<typeof ScheduleChangeResultSchema>;

export const CreateScheduleRequestSchema = z
  .object({
    title: Text(200).min(2),
    weekdays: WeekdaysSchema,
    startTime: LocalTimeSchema,
    endTime: LocalTimeSchema.optional(),
    /** Default: the program's first and last day. */
    startsOn: LocalDateSchema.optional(),
    endsOn: LocalDateSchema.optional(),
    locationName: Text(200)
      .optional()
      .transform((v) => (v ? v : undefined)),
    groupIds: GroupIdsSchema,
  })
  .refine((v) => timeRangeOk(v.startTime, v.endTime), {
    error: 'END_BEFORE_START',
    path: ['endTime'],
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
    error: 'END_BEFORE_START',
    path: ['endsOn'],
  });
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequestSchema>;

/** Applies to occurrences from today on that were not edited individually. */
export const UpdateScheduleRequestSchema = z
  .object({
    title: Text(200).min(2).optional(),
    weekdays: WeekdaysSchema.optional(),
    startTime: LocalTimeSchema.optional(),
    endTime: z.union([LocalTimeSchema, z.null()]).optional(),
    endsOn: LocalDateSchema.optional(),
    locationName: z.union([Text(200), z.null()]).optional(),
    groupIds: GroupIdsSchema.optional(),
    reason: OptionalReason,
  })
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'reason' && v[k as keyof typeof v] !== undefined),
    {
      error: 'NOTHING_TO_UPDATE',
    },
  );
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequestSchema>;

export const ReasonOnlySchema = z.object({ reason: ReasonSchema });
export type ReasonOnly = z.infer<typeof ReasonOnlySchema>;

export const OptionalReasonBodySchema = z.object({ reason: OptionalReason });
export type OptionalReasonBody = z.infer<typeof OptionalReasonBodySchema>;

/* ─────────────────────────── schedule exceptions (§6.1) ─────────────────────────── */

export const ScheduleExceptionSchema = z.object({
  id: Id,
  date: z.string(),
  schedule: z.object({ id: Id, title: z.string() }).nullable(),
  reason: z.string(),
  cancelledVisits: z.number().int().nonnegative(),
  createdAt: IsoDate,
  createdBy: z.string().nullable(),
});
export type ScheduleException = z.infer<typeof ScheduleExceptionSchema>;

/** A day without training: for one schedule, or (no `scheduleId`) for every schedule. */
export const CreateScheduleExceptionRequestSchema = z.object({
  date: LocalDateSchema,
  scheduleId: Id.optional(),
  reason: ReasonSchema,
});
export type CreateScheduleExceptionRequest = z.infer<typeof CreateScheduleExceptionRequestSchema>;

/** An exception added or removed, with the sessions it cancelled or restored. */
export const ExceptionChangeResultSchema = z.object({
  exception: ScheduleExceptionSchema.nullable(),
  affected: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
});
export type ExceptionChangeResult = z.infer<typeof ExceptionChangeResultSchema>;

/* ─────────────────────────── visits (§6.3–6.5) ─────────────────────────── */

export const VISIT_STATUSES = ['SCHEDULED', 'CANCELLED'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

const HttpsUrl = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url({ protocol: /^https$/, error: 'URL_INVALID' }));

export const VisitLocationSchema = z
  .object({
    name: z.union([Text(200), z.null()]).optional(),
    latitude: z.union([z.number().min(-90).max(90), z.null()]).optional(),
    longitude: z.union([z.number().min(-180).max(180), z.null()]).optional(),
    mapUrl: z.union([HttpsUrl, z.null()]).optional(),
  })
  .refine(
    (l) =>
      (l.latitude === undefined || l.latitude === null) ===
      (l.longitude === undefined || l.longitude === null),
    { error: 'COORDINATES_INCOMPLETE', path: ['latitude'] },
  );
export type VisitLocation = z.infer<typeof VisitLocationSchema>;

export const VISIT_FILE_KINDS = ['COVER', 'DOCUMENT'] as const;
export type VisitFileKind = (typeof VISIT_FILE_KINDS)[number];

/**
 * Upload limit per file. Uploads pass through the web server, whose platform
 * (Vercel) caps request bodies at 4.5 MB.
 */
export const VISIT_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const VISIT_MAX_DOCUMENTS = 10;
export const VISIT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VISIT_DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ...VISIT_IMAGE_TYPES,
] as const;

export const UploadVisitFileRequestSchema = z.object({ kind: z.enum(VISIT_FILE_KINDS) });
export type UploadVisitFileRequest = z.infer<typeof UploadVisitFileRequestSchema>;

/**
 * Where a visit stands relative to its check-in window (§8.1): before it opens
 * everything can change; once it opens, date, time, groups and timing are
 * locked; once it closes the visit is over and can no longer be cancelled.
 * Times count in whole minutes, so the closing minute itself is still inside
 * the window (§8.2: for a 10:00 visit closing after 60 minutes, 11:00 is late,
 * not absent).
 */
export const VISIT_PHASES = ['UPCOMING', 'CHECK_IN_OPEN', 'FINISHED'] as const;
export type VisitPhase = (typeof VISIT_PHASES)[number];

export function visitPhase(
  visit: { startsAt: Date; checkInOpensMinutes: number; checkInClosesMinutes: number },
  now: Date = new Date(),
): VisitPhase {
  const t = now.getTime();
  const start = visit.startsAt.getTime();
  if (t < start - visit.checkInOpensMinutes * 60_000) return 'UPCOMING';
  if (t < start + (visit.checkInClosesMinutes + 1) * 60_000) return 'CHECK_IN_OPEN';
  return 'FINISHED';
}

export const VisitFileSchema = z.object({
  id: Id,
  kind: z.enum(VISIT_FILE_KINDS),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Short-lived link (private storage, §16.3). */
  url: z.string(),
  createdAt: IsoDate,
});
export type VisitFile = z.infer<typeof VisitFileSchema>;

export const VisitSummarySchema = z.object({
  id: Id,
  title: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  startsAt: IsoDate,
  endsAt: IsoDate.nullable(),
  status: z.enum(VISIT_STATUSES),
  phase: z.enum(VISIT_PHASES),
  cancelReason: z.string().nullable(),
  locationName: z.string().nullable(),
  groups: z.array(GroupRefSchema),
  scheduleId: Id.nullable(),
});
export type VisitSummary = z.infer<typeof VisitSummarySchema>;

export const VisitDetailSchema = VisitSummarySchema.extend({
  description: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  mapUrl: z.string().nullable(),
  timing: VisitTimingSchema,
  timingOverridden: z.boolean(),
  cover: VisitFileSchema.nullable(),
  documents: z.array(VisitFileSchema),
  /** Edited individually: later schedule changes leave it alone. */
  detached: z.boolean(),
  checkInOpensAt: IsoDate,
  checkInClosesAt: IsoDate,
  schedule: z.object({ id: Id, title: z.string() }).nullable(),
  program: z.object({ id: Id, name: z.string() }),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type VisitDetail = z.infer<typeof VisitDetailSchema>;

export const CreateVisitRequestSchema = z
  .object({
    title: Text(200).min(2),
    description: Text(5000)
      .optional()
      .transform((v) => (v ? v : undefined)),
    date: LocalDateSchema,
    startTime: LocalTimeSchema,
    endTime: LocalTimeSchema.optional(),
    groupIds: GroupIdsSchema,
    location: VisitLocationSchema.optional(),
    /** Override of the program defaults; needs `attendance.settings.visit`. */
    timing: VisitTimingSchema.optional(),
  })
  .refine((v) => timeRangeOk(v.startTime, v.endTime), {
    error: 'END_BEFORE_START',
    path: ['endTime'],
  });
export type CreateVisitRequest = z.infer<typeof CreateVisitRequestSchema>;

export const UpdateVisitRequestSchema = z
  .object({
    title: Text(200).min(2).optional(),
    description: z.union([Text(5000), z.null()]).optional(),
    date: LocalDateSchema.optional(),
    startTime: LocalTimeSchema.optional(),
    endTime: z.union([LocalTimeSchema, z.null()]).optional(),
    groupIds: GroupIdsSchema.optional(),
    location: VisitLocationSchema.optional(),
    /** Explicit timing, or `useDefaults` to copy the program's current defaults. */
    timing: z.union([VisitTimingSchema, z.literal('useDefaults')]).optional(),
    reason: OptionalReason,
  })
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'reason' && v[k as keyof typeof v] !== undefined),
    {
      error: 'NOTHING_TO_UPDATE',
    },
  );
export type UpdateVisitRequest = z.infer<typeof UpdateVisitRequestSchema>;

/** A visit after a change, and how many students were notified of it (§6.4). */
export const VisitMutationResultSchema = z.object({
  visit: VisitDetailSchema,
  notified: z.number().int().nonnegative(),
});
export type VisitMutationResult = z.infer<typeof VisitMutationResultSchema>;

/** Calendar range: at most 100 days at a time. */
export const CalendarQuerySchema = z
  .object({
    from: LocalDateSchema,
    to: LocalDateSchema,
    group: Id.optional(),
    status: z.enum(VISIT_STATUSES).optional(),
  })
  .refine((q) => q.to >= q.from, { error: 'END_BEFORE_START', path: ['to'] })
  .refine((q) => daysBetween(q.from, q.to) <= 100, {
    error: 'RANGE_TOO_LONG',
    path: ['to'],
  });
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

export const CalendarResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Students: their current group (null when they have none). Staff: null. */
  group: GroupRefSchema.nullable(),
  visits: z.array(VisitSummarySchema),
});
export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

export const VisitHistoryEntrySchema = z.object({
  at: IsoDate,
  action: z.string(),
  actorName: z.string().nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type VisitHistoryEntry = z.infer<typeof VisitHistoryEntrySchema>;

/* ─────────────────────────── occurrences ─────────────────────────── */

/** Dates in [startsOn, endsOn] falling on `weekdays`, minus `skip`. */
export function weeklyOccurrences(params: {
  startsOn: LocalDate;
  endsOn: LocalDate;
  weekdays: readonly number[];
  skip?: ReadonlySet<LocalDate>;
}): LocalDate[] {
  const days = new Set(params.weekdays);
  const dates: LocalDate[] = [];
  for (let date = params.startsOn; date <= params.endsOn; date = addDays(date, 1)) {
    if (days.has(weekdayOf(date)) && !params.skip?.has(date)) dates.push(date);
    if (dates.length > 400) break; // a year of daily sessions is the most a program can hold
  }
  return dates;
}

/* ─────────────────────────── notifications (§12) ─────────────────────────── */

export const NOTIFICATION_TYPES = [
  'visit.created',
  'visit.updated',
  'visit.cancelled',
  'visit.restored',
  'visit.removed',
  'schedule.created',
  'schedule.updated',
  'schedule.ended',
  'schedule.removed',
  'verification.approved',
  'verification.rejected',
  'profile_change.approved',
  'profile_change.rejected',
  'attendance.absent',
  'attendance.corrected',
  'attendance.guest_recorded',
  'security.biometric_enabled',
  'security.biometric_revoked',
  'ticket.replied',
  'ticket.status_changed',
  'group_swap.requested',
  'group_swap.accepted',
  'group_swap.under_review',
  'group_swap.counterpart_rejected',
  'group_swap.approved',
  'group_swap.rejected',
  'group_swap.withdrawn',
  'group_swap.cancelled',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Notifications store a type and its parameters, not text: each reader sees
 * them in their own language and time zone (§18.1).
 */
export const NotificationSchema = z.object({
  id: Id,
  type: z.enum(NOTIFICATION_TYPES),
  data: z.record(z.string(), z.unknown()),
  link: z.string().nullable(),
  createdAt: IsoDate,
  readAt: IsoDate.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

export const ListNotificationsResponseSchema = z.object({
  items: z.array(NotificationSchema),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const UnreadCountSchema = z.object({ unread: z.number().int().nonnegative() });
export type UnreadCount = z.infer<typeof UnreadCountSchema>;
