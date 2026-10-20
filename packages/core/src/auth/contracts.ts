import { z } from 'zod';
import { LOCALES } from '../i18n';
import { EmailSchema, SeatNumberSchema } from './identity';
import { NewPasswordSchema, PASSWORD_MAX_LENGTH } from './password-policy';
import { PERMISSION_KEYS } from './permissions';
import { ACCOUNT_STATUSES, ROLES } from './roles';

/* ───────────────────────────── Requests ───────────────────────────── */

export const LoginRequestSchema = z.object({
  /** University email or seat number. */
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const OTP_CODE_PATTERN = /^\d{6}$/;
const OtpCodeSchema = z.string().trim().regex(OTP_CODE_PATTERN, { error: 'CODE_FORMAT' });

export const OtpRequestSchema = z.object({ email: EmailSchema });
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({ email: EmailSchema, code: OtpCodeSchema });
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  email: EmailSchema,
  code: OtpCodeSchema,
  newPassword: NewPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  /** Required when the account already has a password; omitted on first password setup. */
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: NewPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1).max(4096) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const UpdatePreferencesRequestSchema = z.object({ preferredLocale: z.enum(LOCALES) });
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;

/* ───────────────────────────── Responses ──────────────────────────── */

export const MeResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(ROLES),
  status: z.enum(ACCOUNT_STATUSES),
  displayName: z.string(),
  preferredLocale: z.enum(LOCALES),
  /** True until the account sets (first login) or changes (forced) its password. */
  passwordSetupRequired: z.boolean(),
  /** False after a first sign-in by email code: no current password exists to confirm. */
  hasPassword: z.boolean(),
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])),
  studentProfile: z.object({ seatNumber: z.string(), fullName: z.string() }).nullable(),
  facultyProfile: z
    .object({
      fullName: z.string(),
      academicTitle: z.string().nullable(),
      department: z.string().nullable(),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.iso.datetime(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const AuthResponseSchema = TokenPairSchema.extend({ user: MeResponseSchema });
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

/** Body of every "if the account exists, we sent a code" response (anti-enumeration). */
export const AcceptedResponseSchema = z.object({ accepted: z.literal(true) });
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;

/* ─────────────────────────── Admin: users ─────────────────────────── */

const FullNameSchema = z.string().trim().min(2).max(200);
const OptionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => (v ? v : undefined));

export const CreateUserRequestSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('STUDENT'),
    email: EmailSchema,
    fullName: FullNameSchema,
    seatNumber: SeatNumberSchema,
  }),
  z.object({
    role: z.enum(['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY']),
    email: EmailSchema,
    fullName: FullNameSchema,
    academicTitle: OptionalText,
    department: OptionalText,
  }),
]);
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const ListUsersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const UserSummarySchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(ROLES),
  status: z.enum(ACCOUNT_STATUSES),
  displayName: z.string(),
  seatNumber: z.string().nullable(),
  hasPassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const ListUsersResponseSchema = z.object({
  items: z.array(UserSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;

const ReasonSchema = z.string().trim().min(3).max(500);

export const UpdateUserStatusRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: ReasonSchema,
});
export type UpdateUserStatusRequest = z.infer<typeof UpdateUserStatusRequestSchema>;

export const UpdateUserRoleRequestSchema = z.object({
  role: z.enum(['SUPER_ADMIN', 'TRAINING_DIRECTOR', 'FACULTY']),
  reason: ReasonSchema,
});
export type UpdateUserRoleRequest = z.infer<typeof UpdateUserRoleRequestSchema>;

export const SetPermissionGrantsRequestSchema = z.object({
  grants: z
    .array(
      z.object({
        permission: z.enum(PERMISSION_KEYS as [string, ...string[]]),
        effect: z.enum(['ALLOW', 'DENY']),
      }),
    )
    .max(PERMISSION_KEYS.length)
    .refine((list) => new Set(list.map((g) => g.permission)).size === list.length, {
      error: 'DUPLICATE_PERMISSION',
    }),
  reason: ReasonSchema,
});
export type SetPermissionGrantsRequest = z.infer<typeof SetPermissionGrantsRequestSchema>;

export const UserDetailSchema = UserSummarySchema.extend({
  grants: z.array(z.object({ permission: z.string(), effect: z.enum(['ALLOW', 'DENY']) })),
  effectivePermissions: z.array(z.string()),
});
export type UserDetail = z.infer<typeof UserDetailSchema>;
