import { z } from 'zod';
import { GroupRefSchema } from '../students/contracts';
import { LocalDateSchema } from '../scheduling/time';
import { VISIT_STATUSES } from '../scheduling/contracts';
import { SeatNumberSchema } from '../auth/identity';
import { ATTENDANCE_SOURCES, ATTENDANCE_STATUSES } from './classification';
import { CheckInPolicySchema } from './policy';

const Id = z.uuid();
const IsoDate = z.iso.datetime();

/* ─────────────────────────── WebAuthn / biometrics (§4.5) ─────────────────────────── */

/**
 * WebAuthn ceremony payloads are verified cryptographically by the API; here
 * they are only checked for shape (JSON as produced by the browser).
 */
const WebAuthnResponseJson = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().max(32).nullable().optional(),
  })
  .loose();
export type WebAuthnResponseJson = z.infer<typeof WebAuthnResponseJson>;

export const WebAuthnOptionsResponseSchema = z.object({
  challengeId: Id,
  /** PublicKeyCredential{Creation,Request}OptionsJSON for the browser. */
  options: z.record(z.string(), z.unknown()),
});
export type WebAuthnOptionsResponse = z.infer<typeof WebAuthnOptionsResponseSchema>;

export const RegisterCredentialRequestSchema = z.object({
  challengeId: Id,
  /** A label the user recognizes, e.g. "My phone". */
  name: z.string().trim().min(1).max(100),
  response: WebAuthnResponseJson,
});
export type RegisterCredentialRequest = z.infer<typeof RegisterCredentialRequestSchema>;

export const BiometricLoginRequestSchema = z.object({
  challengeId: Id,
  response: WebAuthnResponseJson,
});
export type BiometricLoginRequest = z.infer<typeof BiometricLoginRequestSchema>;

export const BIOMETRIC_CREDENTIAL_KINDS = ['PASSKEY', 'ANDROID_KEY'] as const;
export type BiometricCredentialKind = (typeof BIOMETRIC_CREDENTIAL_KINDS)[number];

export const BiometricCredentialSchema = z.object({
  id: Id,
  /** A browser passkey (WebAuthn) or a key in the FTMS Android app's Keystore. */
  kind: z.enum(BIOMETRIC_CREDENTIAL_KINDS),
  /** Public identifier, so a device can recognize its own entry. */
  credentialId: z.string(),
  name: z.string(),
  createdAt: IsoDate,
  lastUsedAt: IsoDate.nullable(),
  /** Synced passkey (e.g. iCloud Keychain) or bound to one device. */
  multiDevice: z.boolean(),
});
export type BiometricCredential = z.infer<typeof BiometricCredentialSchema>;

/* ─────────── Android device keys: optional biometric sign-in in the app (Phase 8) ─────────── */

/**
 * The Android app keeps an EC P-256 private key in the Android Keystore that can
 * sign only right after a strong biometric check on the device. The server stores
 * the public key and verifies ECDSA-SHA256 signatures over these exact messages,
 * built from a single-use challenge (5 minutes). Biometrics never reach the server.
 */
export const DEVICE_KEY_PROTOCOL = 'ftms-device-key/v1';

export function deviceKeyMessage(
  purpose: 'register' | 'login',
  challengeId: string,
  challenge: string,
  credentialId?: string,
): string {
  return [DEVICE_KEY_PROTOCOL, purpose, challengeId, challenge, credentialId ?? ''].join('|');
}

export const DeviceKeyChallengeSchema = z.object({
  challengeId: Id,
  /** base64url, 32 random bytes. */
  challenge: z.string(),
});
export type DeviceKeyChallenge = z.infer<typeof DeviceKeyChallengeSchema>;

const Base64 = (max: number) =>
  z
    .string()
    .trim()
    .min(16)
    .max(max)
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, { error: 'INVALID_ENCODING' });

export const RegisterDeviceKeyRequestSchema = z.object({
  challengeId: Id,
  /** DER SubjectPublicKeyInfo of the EC P-256 key, base64. */
  publicKey: Base64(400),
  /** DER ECDSA signature over `deviceKeyMessage('register', …)`, base64. */
  signature: Base64(200),
  name: z.string().trim().min(1).max(100),
});
export type RegisterDeviceKeyRequest = z.infer<typeof RegisterDeviceKeyRequestSchema>;

const CredentialIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, { error: 'INVALID_ENCODING' });

export const DeviceKeyLoginOptionsRequestSchema = z.object({ credentialId: CredentialIdSchema });
export type DeviceKeyLoginOptionsRequest = z.infer<typeof DeviceKeyLoginOptionsRequestSchema>;

export const DeviceKeyLoginRequestSchema = z.object({
  challengeId: Id,
  credentialId: CredentialIdSchema,
  signature: Base64(200),
});
export type DeviceKeyLoginRequest = z.infer<typeof DeviceKeyLoginRequestSchema>;

export const RevokeCredentialRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type RevokeCredentialRequest = z.infer<typeof RevokeCredentialRequestSchema>;

/* ─────────────────────────── QR codes (§7) ─────────────────────────── */

export const VisitQrCodesSchema = z.object({
  /** Opens the visit's details page (sign-in required). */
  details: z.object({ url: z.string(), svg: z.string() }),
  /** Stable, HMAC-signed: opens the check-in flow of this visit only (§7.2). */
  attendance: z.object({ url: z.string(), svg: z.string() }),
});
export type VisitQrCodes = z.infer<typeof VisitQrCodesSchema>;

/* ─────────────────────────── records ─────────────────────────── */

export const AttendanceLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracyMeters: z.number().nullable(),
  /** From the visit's coordinates, when both are known (supporting context only). */
  distanceMeters: z.number().nullable(),
});
export type AttendanceLocation = z.infer<typeof AttendanceLocationSchema>;

export const AttendanceRecordSchema = z.object({
  id: Id,
  visitId: Id,
  status: z.enum(ATTENDANCE_STATUSES),
  minutesLate: z.number().int().nonnegative(),
  checkedInAt: IsoDate.nullable(),
  source: z.enum(ATTENDANCE_SOURCES),
  biometricVerified: z.boolean(),
  location: AttendanceLocationSchema.nullable(),
  /** Staff view: who corrected it. Students see the reason only. */
  correction: z
    .object({ at: IsoDate, by: z.string().nullable(), reason: z.string().nullable() })
    .nullable(),
  updatedAt: IsoDate,
});
export type AttendanceRecord = z.infer<typeof AttendanceRecordSchema>;

/* ─────────────────────────── check-in (§7.2, §8.5) ─────────────────────────── */

export const CHECK_IN_STATES = ['NOT_OPEN', 'OPEN', 'CLOSED'] as const;
export type CheckInState = (typeof CHECK_IN_STATES)[number];

/** What the device must send: always a location reading, under the program's policy. */
export const LocationRequirementSchema = CheckInPolicySchema.extend({
  /** A radius is set and the visit has coordinates, so the area is checked. */
  areaEnforced: z.boolean(),
});
export type LocationRequirement = z.infer<typeof LocationRequirementSchema>;

const CheckInVisitSchema = z.object({
  id: Id,
  title: z.string(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string().nullable(),
  locationName: z.string().nullable(),
  status: z.enum(VISIT_STATUSES),
});

const CheckInWindowSchema = z.object({
  state: z.enum(CHECK_IN_STATES),
  opensAt: IsoDate,
  onTimeUntil: IsoDate,
  closesAt: IsoDate,
});

export const CheckInContextSchema = z.object({
  visit: CheckInVisitSchema,
  window: CheckInWindowSchema,
  existing: AttendanceRecordSchema.nullable(),
  location: LocationRequirementSchema,
  serverTime: IsoDate,
});
export type CheckInContext = z.infer<typeof CheckInContextSchema>;

const AttendanceTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{10,100}$/, { error: 'QR_INVALID' });

export const GeolocationReadingSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
});
export type GeolocationReading = z.infer<typeof GeolocationReadingSchema>;

/**
 * A signed-in student's check-in: the QR token and the device location. Nothing
 * else is accepted — status, lateness and time are the server's (§8.2); no
 * biometric step exists (Phase 8: biometrics are for signing in only).
 */
export const CheckInRequestSchema = z.object({
  token: AttendanceTokenSchema,
  /** Always required: the API answers GEOLOCATION_REQUIRED without it. */
  location: GeolocationReadingSchema.optional(),
});
export type CheckInRequest = z.infer<typeof CheckInRequestSchema>;

export const CheckInResultSchema = z.object({ record: AttendanceRecordSchema });
export type CheckInResult = z.infer<typeof CheckInResultSchema>;

/* ─────────────────────────── guest attendance (Phase 8) ─────────────────────────── */

/**
 * Attendance without signing in: the printed QR code, a typed full name and seat
 * number, and the device location. The name and seat number are NOT verified — no
 * account, password, code, biometric or document is asked for (a deliberate policy).
 */
export const GuestContextRequestSchema = z.object({ token: AttendanceTokenSchema });
export type GuestContextRequest = z.infer<typeof GuestContextRequestSchema>;

/** Only what is safe to show anyone holding the QR code: no groups, students or records. */
export const GuestCheckInContextSchema = z.object({
  visit: CheckInVisitSchema.omit({ id: true }),
  window: CheckInWindowSchema,
  location: LocationRequirementSchema,
  serverTime: IsoDate,
});
export type GuestCheckInContext = z.infer<typeof GuestCheckInContextSchema>;

export const GUEST_NAME_MIN_LENGTH = 3;

export const GuestCheckInRequestSchema = z.object({
  token: AttendanceTokenSchema,
  /** Generated by the device per submission: a retried request gets the first answer. */
  submissionKey: Id,
  fullName: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, ' '))
    .pipe(
      z
        .string()
        .min(GUEST_NAME_MIN_LENGTH, { error: 'NAME_TOO_SHORT' })
        .max(200, { error: 'NAME_TOO_LONG' })
        .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, { error: 'NAME_INVALID' }),
    ),
  seatNumber: SeatNumberSchema,
  /** Always required: the API answers GEOLOCATION_REQUIRED without it. */
  location: GeolocationReadingSchema.optional(),
});
export type GuestCheckInRequest = z.infer<typeof GuestCheckInRequestSchema>;

/**
 * The answer is the same whatever the typed seat number matches: it describes the
 * submission (time and classification by the server's clock), never a student.
 */
export const GuestCheckInResultSchema = z.object({
  receipt: z.object({
    /** Reference the person can show the training office. */
    id: Id,
    status: z.enum(['PRESENT', 'LATE']),
    minutesLate: z.number().int().nonnegative(),
    submittedAt: IsoDate,
    visitTitle: z.string(),
  }),
});
export type GuestCheckInResult = z.infer<typeof GuestCheckInResultSchema>;

export const GUEST_CHECK_IN_OUTCOMES = ['RECORDED', 'DUPLICATE', 'UNMATCHED'] as const;
export type GuestCheckInOutcome = (typeof GUEST_CHECK_IN_OUTCOMES)[number];

/** Staff view of one guest submission (typed values, not verified). */
export const GuestSubmissionSchema = z.object({
  id: Id,
  fullName: z.string(),
  seatNumber: z.string(),
  status: z.enum(['PRESENT', 'LATE']),
  minutesLate: z.number().int(),
  submittedAt: IsoDate,
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    accuracyMeters: z.number().nullable(),
    distanceMeters: z.number().nullable(),
  }),
  outcome: z.enum(GUEST_CHECK_IN_OUTCOMES),
  /** The student whose seat number was typed, when one matched. */
  student: z.object({ id: Id, fullName: z.string() }).nullable(),
  /** The typed name matches that student's record (spelling-insensitive). */
  nameMatches: z.boolean().nullable(),
});
export type GuestSubmission = z.infer<typeof GuestSubmissionSchema>;

/* ─────────────────────────── faculty: tables and corrections (§8.4, §10.3) ─────────────────────────── */

export const CorrectAttendanceRequestSchema = z
  .object({
    status: z.enum(ATTENDANCE_STATUSES),
    minutesLate: z.number().int().min(1).max(720).optional(),
    reason: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .refine((v) => v.status !== 'LATE' || v.minutesLate !== undefined, {
    error: 'LATE_MINUTES_REQUIRED',
    path: ['minutesLate'],
  })
  .refine((v) => v.status === 'LATE' || v.minutesLate === undefined, {
    error: 'MINUTES_ONLY_WHEN_LATE',
    path: ['minutesLate'],
  });
export type CorrectAttendanceRequest = z.infer<typeof CorrectAttendanceRequestSchema>;

/** Rows can also be filtered to students without a record yet. */
export const ATTENDANCE_FILTER_STATUSES = [...ATTENDANCE_STATUSES, 'NOT_RECORDED'] as const;

export const VisitAttendanceQuerySchema = z.object({
  group: Id.optional(),
  status: z.enum(ATTENDANCE_FILTER_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
export type VisitAttendanceQuery = z.infer<typeof VisitAttendanceQuerySchema>;

export const VisitAttendanceRowSchema = z.object({
  student: z.object({ id: Id, fullName: z.string(), seatNumber: z.string() }),
  /** The group the record was made under, or the student's current group. */
  group: GroupRefSchema.nullable(),
  record: AttendanceRecordSchema.nullable(),
  /** Currently in one of the visit's groups. */
  expected: z.boolean(),
});
export type VisitAttendanceRow = z.infer<typeof VisitAttendanceRowSchema>;

export const AttendanceCountsSchema = z.object({
  expected: z.number().int(),
  present: z.number().int(),
  late: z.number().int(),
  absent: z.number().int(),
  notRecorded: z.number().int(),
});
export type AttendanceCounts = z.infer<typeof AttendanceCountsSchema>;

export const VisitAttendanceResponseSchema = z.object({
  visit: z.object({
    id: Id,
    title: z.string(),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string().nullable(),
    status: z.enum(VISIT_STATUSES),
    groups: z.array(GroupRefSchema),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  }),
  window: z.object({ state: z.enum(CHECK_IN_STATES), opensAt: IsoDate, closesAt: IsoDate }),
  /** Absences have been recorded for students without a check-in. */
  absencesProcessed: z.boolean(),
  counts: AttendanceCountsSchema,
  rows: z.array(VisitAttendanceRowSchema),
  /** Every guest submission for the visit, newest first (Phase 8). */
  guestSubmissions: z.array(GuestSubmissionSchema),
});
export type VisitAttendanceResponse = z.infer<typeof VisitAttendanceResponseSchema>;

/* ─────────────────────────── dashboards (§9, §10.1) ─────────────────────────── */

export const OwnAttendanceEntrySchema = z.object({
  visit: z.object({
    id: Id,
    title: z.string(),
    date: z.string(),
    startTime: z.string(),
    endTime: z.string().nullable(),
  }),
  status: z.enum(ATTENDANCE_STATUSES),
  minutesLate: z.number().int(),
  checkedInAt: IsoDate.nullable(),
  source: z.enum(ATTENDANCE_SOURCES),
  /** The reason given with a faculty correction (the corrector is not shown). */
  note: z.string().nullable(),
});
export type OwnAttendanceEntry = z.infer<typeof OwnAttendanceEntrySchema>;

export const OwnAttendanceSummarySchema = z.object({
  /** Visits of the student's group in the program (cancelled ones excluded). */
  scheduledVisits: z.number().int(),
  upcomingVisits: z.number().int(),
  attended: z.number().int(),
  present: z.number().int(),
  late: z.number().int(),
  absent: z.number().int(),
  allowedAbsences: z.number().int(),
  remainingAbsences: z.number().int(),
});
export type OwnAttendanceSummary = z.infer<typeof OwnAttendanceSummarySchema>;

export const OwnAttendanceResponseSchema = z.object({
  summary: OwnAttendanceSummarySchema.nullable(),
  records: z.array(OwnAttendanceEntrySchema),
});
export type OwnAttendanceResponse = z.infer<typeof OwnAttendanceResponseSchema>;

export const AttendanceOverviewSchema = z.object({
  visits: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    remaining: z.number().int(),
    nextSevenDays: z.number().int(),
  }),
  records: z.object({
    present: z.number().int(),
    late: z.number().int(),
    absent: z.number().int(),
  }),
  groups: z.array(
    z.object({
      group: GroupRefSchema,
      completedVisits: z.number().int(),
      present: z.number().int(),
      late: z.number().int(),
      absent: z.number().int(),
    }),
  ),
});
export type AttendanceOverview = z.infer<typeof AttendanceOverviewSchema>;

/* ─────────────────────────── exports (§10.4, §19) ─────────────────────────── */

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Larger reports must be narrowed with filters (serverless response limits). */
export const EXPORT_MAX_ROWS = { csv: 10_000, xlsx: 10_000, pdf: 3_000 } as const;

export const ExportQuerySchema = z
  .object({
    format: z.enum(EXPORT_FORMATS),
    visit: Id.optional(),
    from: LocalDateSchema.optional(),
    to: LocalDateSchema.optional(),
    group: Id.optional(),
    student: Id.optional(),
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    locale: z.enum(['ar', 'en']).default('ar'),
  })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { error: 'END_BEFORE_START', path: ['to'] });
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

/** One exported line; the same rows feed CSV, XLSX and PDF. */
export interface AttendanceExportRow {
  visitTitle: string;
  date: string;
  scheduledTime: string;
  group: string;
  studentName: string;
  seatNumber: string;
  status: (typeof ATTENDANCE_STATUSES)[number];
  checkedInAt: string;
  minutesLate: number;
  /**
   * The record's source, or `GUEST_UNMATCHED` for a guest submission whose typed
   * seat number matched no current member of the visit's groups (no record exists).
   */
  source: (typeof ATTENDANCE_SOURCES)[number] | 'GUEST_UNMATCHED';
  note: string;
}
