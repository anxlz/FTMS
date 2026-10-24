import { z } from 'zod';
import { AuthResponseSchema } from '../auth/contracts';
import { EmailSchema, SeatNumberSchema } from '../auth/identity';
import { ACCOUNT_STATUSES } from '../auth/roles';
import { FourPartNameSchema, NAME_PARTS, NamePartsSchema, PhoneSchema } from './names';

/* ───────────────────────────── shared pieces ───────────────────────────── */

const Id = z.uuid();
const IsoDate = z.iso.datetime();
const ReasonSchema = z.string().trim().min(3).max(500);
const OptionalReason = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => (v ? v : undefined));

/** Empty string or null clears an optional value; undefined leaves it unchanged. */
const clearable = <T extends z.ZodType>(schema: T) =>
  z.union([schema, z.literal('').transform(() => null), z.null()]).optional();

/* ─────────────────────────────── groups ─────────────────────────────── */

export const GROUP_NAME_MAX_LENGTH = 100;

export const GroupNameSchema = z
  .string()
  .transform((v) => v.normalize('NFC').replace(/\s+/gu, ' ').trim())
  .pipe(z.string().min(1, { error: 'GROUP_NAME_REQUIRED' }).max(GROUP_NAME_MAX_LENGTH));

/** Case- and spacing-insensitive group-name key (mirrors the database unique index). */
export const groupNameKey = (name: string): string =>
  name.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

export const GroupRefSchema = z.object({ id: Id, name: z.string() });
export type GroupRef = z.infer<typeof GroupRefSchema>;

export const GroupSchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  archived: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  createdAt: IsoDate,
});
export type Group = z.infer<typeof GroupSchema>;

export const GroupMemberSchema = z.object({
  studentId: Id,
  seatNumber: z.string(),
  fullName: z.string(),
  since: IsoDate,
  hasAccount: z.boolean(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GroupDetailSchema = GroupSchema.extend({ members: z.array(GroupMemberSchema) });
export type GroupDetail = z.infer<typeof GroupDetailSchema>;

export const ListGroupsQuerySchema = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListGroupsQuery = z.infer<typeof ListGroupsQuerySchema>;

export const CreateGroupRequestSchema = z.object({
  name: GroupNameSchema,
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

export const UpdateGroupRequestSchema = z
  .object({
    name: GroupNameSchema.optional(),
    description: clearable(z.string().trim().min(1).max(500)),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    error: 'NOTHING_TO_UPDATE',
  });
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequestSchema>;

export const SetGroupArchivedRequestSchema = z.object({ archived: z.boolean() });
export type SetGroupArchivedRequest = z.infer<typeof SetGroupArchivedRequestSchema>;

export const AssignMembersRequestSchema = z.object({
  studentIds: z
    .array(Id)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'DUPLICATE_STUDENT' }),
  /**
   * Students already in another group are moved only when this is true; otherwise
   * the request is refused and nothing changes (§5: one active group per student).
   */
  moveFromOtherGroup: z.boolean().default(false),
  reason: OptionalReason,
});
export type AssignMembersRequest = z.infer<typeof AssignMembersRequestSchema>;

export const AssignMembersResponseSchema = z.object({
  added: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  alreadyMembers: z.number().int().nonnegative(),
});
export type AssignMembersResponse = z.infer<typeof AssignMembersResponseSchema>;

export const RemoveMemberRequestSchema = z.object({ reason: OptionalReason });
export type RemoveMemberRequest = z.infer<typeof RemoveMemberRequestSchema>;

/* ─────────────────────────── student records ─────────────────────────── */

export const STUDENT_ACCOUNT_FILTERS = ['linked', 'unlinked'] as const;

export const StudentAccountSchema = z.object({
  userId: Id,
  email: z.email(),
  status: z.enum(ACCOUNT_STATUSES),
  hasPassword: z.boolean(),
  lastLoginAt: IsoDate.nullable(),
});

export const StudentRecordSchema = z.object({
  id: Id,
  seatNumber: z.string(),
  fullName: z.string(),
  firstName: z.string().nullable(),
  fatherName: z.string().nullable(),
  grandfatherName: z.string().nullable(),
  familyName: z.string().nullable(),
  universityEmail: z.string().nullable(),
  phone: z.string().nullable(),
  group: GroupRefSchema.nullable(),
  account: StudentAccountSchema.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type StudentRecord = z.infer<typeof StudentRecordSchema>;

export const MEMBERSHIP_SOURCES = ['MANUAL', 'IMPORT', 'VERIFICATION', 'SWAP'] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

export const StudentDetailSchema = StudentRecordSchema.extend({
  memberships: z.array(
    z.object({
      group: GroupRefSchema,
      startedAt: IsoDate,
      endedAt: IsoDate.nullable(),
      source: z.enum(MEMBERSHIP_SOURCES),
    }),
  ),
  pendingProfileChangeId: Id.nullable(),
});
export type StudentDetail = z.infer<typeof StudentDetailSchema>;

export const ListStudentsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  /** A group id, or "none" for students without a group. */
  group: z.union([Id, z.literal('none')]).optional(),
  account: z.enum(STUDENT_ACCOUNT_FILTERS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListStudentsQuery = z.infer<typeof ListStudentsQuerySchema>;

export const ListStudentsResponseSchema = z.object({
  items: z.array(StudentRecordSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListStudentsResponse = z.infer<typeof ListStudentsResponseSchema>;

export const CreateStudentRequestSchema = z.object({
  seatNumber: SeatNumberSchema,
  name: NamePartsSchema,
  universityEmail: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  /** Requires `groups.manage` as well as `students.manage`. */
  groupId: Id.optional(),
});
export type CreateStudentRequest = z.infer<typeof CreateStudentRequestSchema>;

export const UpdateStudentRequestSchema = z
  .object({
    seatNumber: SeatNumberSchema.optional(),
    name: NamePartsSchema.optional(),
    /** Locked once an account is linked: the account's verified email is authoritative. */
    universityEmail: clearable(EmailSchema),
    phone: clearable(PhoneSchema),
    reason: OptionalReason,
  })
  .refine(
    (v) =>
      v.seatNumber !== undefined ||
      v.name !== undefined ||
      v.universityEmail !== undefined ||
      v.phone !== undefined,
    { error: 'NOTHING_TO_UPDATE' },
  );
export type UpdateStudentRequest = z.infer<typeof UpdateStudentRequestSchema>;

/** `groupId: null` removes the student from their group. Requires `groups.manage`. */
export const SetStudentGroupRequestSchema = z.object({
  groupId: Id.nullable(),
  reason: OptionalReason,
});
export type SetStudentGroupRequest = z.infer<typeof SetStudentGroupRequestSchema>;

export const ReasonRequestSchema = z.object({ reason: ReasonSchema });
export type ReasonRequest = z.infer<typeof ReasonRequestSchema>;

/* ───────────────────────── student self-service ───────────────────────── */

export const OwnStudentProfileSchema = z.object({
  seatNumber: z.string(),
  fullName: z.string(),
  firstName: z.string().nullable(),
  fatherName: z.string().nullable(),
  grandfatherName: z.string().nullable(),
  familyName: z.string().nullable(),
  universityEmail: z.string().nullable(),
  phone: z.string().nullable(),
  group: GroupRefSchema.nullable(),
});
export type OwnStudentProfile = z.infer<typeof OwnStudentProfileSchema>;

/** Fields a student may change directly; protected fields go through a request (§4.4). */
export const UpdateOwnProfileRequestSchema = z.object({ phone: clearable(PhoneSchema) });
export type UpdateOwnProfileRequest = z.infer<typeof UpdateOwnProfileRequestSchema>;

/* ─────────────────────── protected profile changes (§4.4) ─────────────────────── */

/** Identity fields that change only through an approved request. */
export const PROTECTED_PROFILE_FIELDS = ['seatNumber', ...NAME_PARTS] as const;
export type ProtectedProfileField = (typeof PROTECTED_PROFILE_FIELDS)[number];

export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const SubmitProfileChangeRequestSchema = z
  .object({
    seatNumber: SeatNumberSchema.optional(),
    firstName: FourPartNameSchema.shape.firstName.optional(),
    fatherName: FourPartNameSchema.shape.fatherName.optional(),
    grandfatherName: FourPartNameSchema.shape.grandfatherName.optional(),
    familyName: FourPartNameSchema.shape.familyName.optional(),
    note: ReasonSchema,
  })
  .refine((v) => PROTECTED_PROFILE_FIELDS.some((key) => v[key] !== undefined), {
    error: 'NOTHING_TO_UPDATE',
  });
export type SubmitProfileChangeRequest = z.infer<typeof SubmitProfileChangeRequestSchema>;

export const FieldChangeSchema = z.object({
  field: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type FieldChange = z.infer<typeof FieldChangeSchema>;

/**
 * A request as its author sees it. Deliberately has no reviewer identity:
 * students never see who decided (§13.3 privacy applies to every review flow).
 */
export const OwnProfileChangeSchema = z.object({
  id: Id,
  status: z.enum(REQUEST_STATUSES),
  changes: z.array(FieldChangeSchema),
  note: z.string(),
  createdAt: IsoDate,
  decidedAt: IsoDate.nullable(),
  decisionReason: z.string().nullable(),
});
export type OwnProfileChange = z.infer<typeof OwnProfileChangeSchema>;

export const ProfileChangeReviewSchema = OwnProfileChangeSchema.extend({
  student: z.object({ id: Id, seatNumber: z.string(), fullName: z.string() }),
  decidedBy: z.object({ name: z.string() }).nullable(),
});
export type ProfileChangeReview = z.infer<typeof ProfileChangeReviewSchema>;

export const ListRequestsQuerySchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRequestsQuery = z.infer<typeof ListRequestsQuerySchema>;

export const ListProfileChangesResponseSchema = z.object({
  items: z.array(ProfileChangeReviewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListProfileChangesResponse = z.infer<typeof ListProfileChangesResponseSchema>;

export const ApproveRequestSchema = z.object({ comment: OptionalReason });
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

/* ─────────────────────────── signup (§4.2) ─────────────────────────── */

export const SignupRequestSchema = FourPartNameSchema.extend({
  email: EmailSchema,
  seatNumber: SeatNumberSchema,
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const SignupVerifySchema = SignupRequestSchema.extend({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: 'CODE_FORMAT' }),
});
export type SignupVerify = z.infer<typeof SignupVerifySchema>;

/**
 * Result of a verified signup. `linked`: matched an imported record and the account
 * is active (Case A). Otherwise the account waits for faculty review (Case B).
 */
export const SignupResponseSchema = AuthResponseSchema.extend({ linked: z.boolean() });
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

/* ───────────────────── pending-verification accounts (§4.2 Case B) ───────────────────── */

export const VERIFICATION_ISSUES = [
  'NO_RECORD',
  'SEAT_ALREADY_LINKED',
  'DETAILS_MISMATCH',
  'EMAIL_ON_OTHER_RECORD',
] as const;
export type VerificationIssue = (typeof VERIFICATION_ISSUES)[number];

export const SubmittedIdentitySchema = z.object({
  seatNumber: z.string(),
  firstName: z.string(),
  fatherName: z.string(),
  grandfatherName: z.string(),
  familyName: z.string(),
  fullName: z.string(),
});

/** The student's own view: no matching diagnostics, no reviewer identity. */
export const OwnVerificationSchema = z.object({
  /** `NONE`: no request yet (e.g. after an unlink); the student can submit one. */
  state: z.enum(['NONE', 'PENDING', 'REJECTED', 'VERIFIED']),
  request: z
    .object({
      id: Id,
      status: z.enum(REQUEST_STATUSES),
      submitted: SubmittedIdentitySchema,
      createdAt: IsoDate,
      decidedAt: IsoDate.nullable(),
      decisionReason: z.string().nullable(),
    })
    .nullable(),
});
export type OwnVerification = z.infer<typeof OwnVerificationSchema>;

export const SubmitVerificationRequestSchema = FourPartNameSchema.extend({
  seatNumber: SeatNumberSchema,
});
export type SubmitVerificationRequest = z.infer<typeof SubmitVerificationRequestSchema>;

export const SubmitVerificationResponseSchema = z.object({ linked: z.boolean() });
export type SubmitVerificationResponse = z.infer<typeof SubmitVerificationResponseSchema>;

export const VerificationReviewSchema = z.object({
  id: Id,
  status: z.enum(REQUEST_STATUSES),
  issue: z.enum(VERIFICATION_ISSUES),
  account: z.object({ userId: Id, email: z.email(), displayName: z.string() }),
  submitted: SubmittedIdentitySchema,
  createdAt: IsoDate,
  decidedAt: IsoDate.nullable(),
  decisionReason: z.string().nullable(),
  decidedBy: z.object({ name: z.string() }).nullable(),
  linkedStudentId: Id.nullable(),
});
export type VerificationReview = z.infer<typeof VerificationReviewSchema>;

export const VerificationReviewDetailSchema = VerificationReviewSchema.extend({
  /** Records that could belong to this person: same seat, same email, or same name. */
  candidates: z.array(
    StudentRecordSchema.extend({
      reasons: z.array(z.enum(['SEAT_NUMBER', 'EMAIL', 'NAME'])),
    }),
  ),
});
export type VerificationReviewDetail = z.infer<typeof VerificationReviewDetailSchema>;

export const ListVerificationsResponseSchema = z.object({
  items: z.array(VerificationReviewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListVerificationsResponse = z.infer<typeof ListVerificationsResponseSchema>;

export const ApproveVerificationRequestSchema = z.discriminatedUnion('mode', [
  /** Link the account to an existing (unlinked) record chosen by the reviewer. */
  z.object({ mode: z.literal('LINK'), studentId: Id, comment: OptionalReason }),
  /** Create a new record from the submitted details (seat number must be free). */
  z.object({ mode: z.literal('CREATE'), groupId: Id.optional(), comment: OptionalReason }),
]);
export type ApproveVerificationRequest = z.infer<typeof ApproveVerificationRequestSchema>;

/* ─────────────────────────── spreadsheet import (§4.1) ─────────────────────────── */

export const IMPORT_MAX_ROWS = 5000;
/** Vercel functions accept request bodies up to 4.5 MB; keep uploads below that. */
export const IMPORT_MAX_FILE_BYTES = 4 * 1024 * 1024;

export const IMPORT_COLUMNS = [
  'seatNumber',
  'fullName',
  'firstName',
  'fatherName',
  'grandfatherName',
  'familyName',
  'universityEmail',
  'group',
  'phone',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** Per-row problems, translated by clients. */
export const IMPORT_ROW_ERRORS = [
  'SEAT_REQUIRED',
  'SEAT_NUMBER_INVALID',
  'NAME_REQUIRED',
  'NAME_TOO_SHORT',
  'NAME_TOO_LONG',
  'NAME_INVALID',
  'NAME_PARTS_MISMATCH',
  'EMAIL_INVALID',
  'EMAIL_NOT_UNIVERSITY',
  'PHONE_INVALID',
  'CELL_UNREADABLE',
  'GROUP_NOT_FOUND',
  'GROUP_ARCHIVED',
  'GROUP_PERMISSION_REQUIRED',
  'DUPLICATE_SEAT_IN_FILE',
  'DUPLICATE_EMAIL_IN_FILE',
  'EMAIL_USED_BY_OTHER_STUDENT',
  'EMAIL_USED_BY_STAFF',
  'EMAIL_LOCKED_BY_ACCOUNT',
] as const;
export type ImportRowError = (typeof IMPORT_ROW_ERRORS)[number];

export const IMPORT_ROW_ACTIONS = ['CREATE', 'UPDATE', 'UNCHANGED', 'ERROR'] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];

export const ImportRowSchema = z.object({
  /** Row number as shown in the spreadsheet application. */
  rowNumber: z.number().int().min(1),
  action: z.enum(IMPORT_ROW_ACTIONS),
  seatNumber: z.string().nullable(),
  fullName: z.string().nullable(),
  universityEmail: z.string().nullable(),
  group: z.string().nullable(),
  errors: z.array(z.enum(IMPORT_ROW_ERRORS)),
  /** For UPDATE rows: what would change on the existing record. */
  changes: z.array(FieldChangeSchema),
  studentId: Id.nullable(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const IMPORT_STATUSES = ['PREVIEW', 'COMMITTED', 'DISCARDED', 'EXPIRED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const ImportSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});
export type ImportSummary = z.infer<typeof ImportSummarySchema>;

export const ImportResultSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skippedUpdates: z.number().int().nonnegative(),
  skippedInvalid: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const ImportSummaryItemSchema = z.object({
  id: Id,
  status: z.enum(IMPORT_STATUSES),
  fileName: z.string(),
  createdAt: IsoDate,
  createdBy: z.object({ name: z.string() }),
  summary: ImportSummarySchema,
  result: ImportResultSchema.nullable(),
  committedAt: IsoDate.nullable(),
});
export type ImportSummaryItem = z.infer<typeof ImportSummaryItemSchema>;

export const ImportPreviewSchema = ImportSummaryItemSchema.extend({
  expiresAt: IsoDate,
  /** Spreadsheet headers that were not recognized and were ignored. */
  ignoredColumns: z.array(z.string()),
  /** Digest of the plan shown; the commit is refused if the data changed since. */
  planDigest: z.string(),
  rows: z.array(ImportRowSchema),
  /** True when the current user created this import (only they can commit it). */
  ownedByMe: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export const ListImportsResponseSchema = z.object({ items: z.array(ImportSummaryItemSchema) });
export type ListImportsResponse = z.infer<typeof ListImportsResponseSchema>;

export const CommitImportRequestSchema = z.object({
  /** The digest of the preview the user confirmed. */
  planDigest: z.string().min(16).max(128),
  /** Explicit confirmation to change existing records (§4.1.6). */
  applyUpdates: z.boolean(),
  /** Explicit acknowledgment that rows with errors are left out. */
  skipInvalidRows: z.boolean(),
});
export type CommitImportRequest = z.infer<typeof CommitImportRequestSchema>;
