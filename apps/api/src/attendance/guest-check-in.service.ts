import { Injectable } from '@nestjs/common';
import {
  type GuestCheckInContext,
  type GuestCheckInRequest,
  type GuestCheckInResult,
  type GuestSubmission,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { LIMITS, type LimitPolicy } from '../auth/auth.constants';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import {
  type GuestCheckIn,
  type GuestCheckInOutcome,
  type Prisma,
} from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../rate-limit/rate-limiter';
import { fromDbDate } from '../scheduling/db-values';
import { AttendanceErrors } from './attendance-errors';
import { AttendanceTokens } from './attendance-tokens';
import {
  assertLocation,
  assertOpen,
  locationRequirement,
  visitForToken,
  visitSummary,
} from './check-in-rules';

type Tx = Prisma.TransactionClient;

const receipt = (row: GuestCheckIn & { visit: { title: string } }): GuestCheckInResult => ({
  receipt: {
    id: row.id,
    status: row.status === 'LATE' ? 'LATE' : 'PRESENT',
    minutesLate: row.minutesLate,
    submittedAt: row.submittedAt.toISOString(),
    visitTitle: row.visit.title,
  },
});

/**
 * Guest attendance (Phase 8): a printed visit QR code, a typed full name and seat
 * number, and the device location — no account, password, code, biometrics or
 * identity check, by deliberate policy. The server checks what it can: the token,
 * that the visit takes place, the window (server clock), the form, the location
 * policy, and abuse limits. **The typed identity is not verified.**
 *
 * For record keeping the typed seat number is compared with the visit's groups:
 * when it belongs to a current member without a record, an attendance record is
 * created for that student with source GUEST (unverified, reviewable by staff).
 * The answer to the guest is identical in every case — it describes the
 * submission, never whether a seat number exists, whom it belongs to, or whether
 * that student already has a record.
 */
@Injectable()
export class GuestCheckInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: AttendanceTokens,
    private readonly notifications: NotificationsService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  private async limit(bucket: string, policy: LimitPolicy, context: RequestContext) {
    const state = await this.limiter.hit(
      rateLimitKey(bucket, context.ip ?? 'unknown'),
      policy.windowSeconds,
    );
    if (state.count > policy.limit) {
      throw Errors.rateLimited(state.resetInSeconds || policy.windowSeconds);
    }
  }

  /** What a guest may see after scanning: the visit's title, day, time and place, and the window. */
  async context(token: string, context: RequestContext): Promise<GuestCheckInContext> {
    await this.limit('guest-context-ip', LIMITS.guestContextPerIp, context);
    const { visit, program } = await visitForToken(this.prisma, this.tokens, token);
    const now = this.clock.now();
    const { visit: summary, window } = visitSummary(visit, now);
    const { id: _id, ...shown } = summary;
    return {
      visit: shown,
      window,
      location: locationRequirement(visit, program),
      serverTime: now.toISOString(),
    };
  }

  async submit(input: GuestCheckInRequest, context: RequestContext): Promise<GuestCheckInResult> {
    await this.limit('guest-submit-ip', LIMITS.guestSubmissionsPerIp, context);
    const visitId = this.tokens.verify(input.token);
    if (!visitId) throw AttendanceErrors.qrInvalid();

    // A retried request (same submission key) gets the first answer, not a second row.
    const replay = await this.findPrior(visitId, input.submissionKey);
    if (replay) return receipt(replay);

    const now = this.clock.now();
    const pre = await visitForToken(this.prisma, this.tokens, input.token);
    assertOpen(pre.visit, now);
    assertLocation(input.location, pre.visit, pre.program);

    // Two attempts at most: a concurrent check-in for the same student (signed in or
    // guest) makes the first one lose the unique key; the retry then sees the record.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await this.prisma.$transaction((tx) => this.record(tx, input, now, context));
        return receipt(row);
      } catch (error) {
        if (isUniqueViolation(error, 'guest_check_ins_visit_id_submission_key_key')) {
          const prior = await this.findPrior(visitId, input.submissionKey);
          if (prior) return receipt(prior);
        }
        if (
          attempt === 0 &&
          isUniqueViolation(error, 'attendance_records_visit_id_student_id_key')
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private findPrior(visitId: string, submissionKey: string) {
    return this.prisma.guestCheckIn.findUnique({
      where: { visitId_submissionKey: { visitId, submissionKey } },
      include: { visit: { select: { title: true } } },
    });
  }

  private async record(
    tx: Tx,
    input: GuestCheckInRequest,
    now: Date,
    context: RequestContext,
  ): Promise<GuestCheckIn & { visit: { title: string } }> {
    // Serialize with cancellation/rescheduling of the visit, then re-check everything.
    const visitId = this.tokens.verify(input.token);
    if (!visitId) throw AttendanceErrors.qrInvalid();
    await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${visitId}::uuid FOR SHARE`;
    const { visit, program } = await visitForToken(tx, this.tokens, input.token);
    const outcome = assertOpen(visit, now);
    const { reading: location, distance } = assertLocation(input.location, visit, program);

    // Record keeping only (never a condition, never revealed): does the typed seat
    // number belong to a current member of one of the visit's groups?
    const student = await tx.studentProfile.findUnique({
      where: { seatNumber: input.seatNumber },
      select: { id: true, userId: true, nameKey: true },
    });
    const membership = student
      ? await tx.groupMembership.findFirst({
          where: { studentId: student.id, endedAt: null },
          select: { groupId: true },
        })
      : null;
    const inVisit =
      membership &&
      (await tx.visitGroup.findUnique({
        where: { visitId_groupId: { visitId: visit.id, groupId: membership.groupId } },
      }));

    let result: GuestCheckInOutcome;
    let recordId: string | null = null;
    let matchedId: string | null = null;
    if (student && membership && inVisit) {
      matchedId = student.id;
      const existing = await tx.attendanceRecord.findUnique({
        where: { visitId_studentId: { visitId: visit.id, studentId: student.id } },
        select: { id: true },
      });
      if (existing) {
        result = 'DUPLICATE';
      } else {
        const created = await tx.attendanceRecord.create({
          data: {
            visitId: visit.id,
            studentId: student.id,
            groupId: membership.groupId,
            status: outcome.result,
            minutesLate: outcome.minutesLate,
            checkedInAt: now,
            source: 'GUEST',
            latitude: location.latitude,
            longitude: location.longitude,
            accuracyMeters: location.accuracy ?? null,
            distanceMeters: distance,
          },
        });
        recordId = created.id;
        result = 'RECORDED';
      }
    } else {
      const earlier = await tx.guestCheckIn.findFirst({
        where: { visitId: visit.id, seatNumber: input.seatNumber },
        select: { id: true },
      });
      result = earlier ? 'DUPLICATE' : 'UNMATCHED';
    }

    let nameMatches: boolean | null = null;
    if (matchedId && student) {
      const [row] = await tx.$queryRaw<{ same: boolean }[]>`
        SELECT "ftms_name_key"(${input.fullName}) = ${student.nameKey} AS "same"`;
      nameMatches = row?.same ?? false;
    }

    const created = await tx.guestCheckIn.create({
      data: {
        visitId: visit.id,
        submissionKey: input.submissionKey,
        fullName: input.fullName,
        seatNumber: input.seatNumber,
        status: outcome.result,
        minutesLate: outcome.minutesLate,
        submittedAt: now,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracy ?? null,
        distanceMeters: distance,
        outcome: result,
        studentId: matchedId,
        attendanceRecordId: recordId,
        nameMatches,
      },
      include: { visit: { select: { title: true } } },
    });

    // No name or seat number in the log: the submission row holds them for staff.
    await this.audit.record(
      {
        actor: null,
        action: 'attendance.guest_submitted',
        resourceType: 'guest_check_in',
        resourceId: created.id,
        outcome: 'SUCCESS',
        after: {
          visitId: visit.id,
          status: created.status,
          minutesLate: created.minutesLate,
          outcome: result,
          attendanceRecordId: recordId,
        },
        metadata: { geolocation: true, distanceMeters: distance, nameMatches },
        context,
      },
      tx,
    );

    // The student whose seat number was used learns about it at once: their own
    // record changed, possibly by someone else (the identity is not verified).
    if (result === 'RECORDED' && student?.userId) {
      await this.notifications.notify(tx, [student.userId], {
        type: 'attendance.guest_recorded',
        data: {
          visitId: visit.id,
          title: visit.title,
          date: fromDbDate(visit.date),
          status: created.status,
          minutesLate: created.minutesLate,
          submittedAt: now.toISOString(),
        },
        link: '/attendance',
        dedupeKey: `attendance.guest_recorded:${recordId}`,
      });
    }
    return created;
  }

  /** Staff view: every guest submission of a visit, newest first. */
  async forVisit(visitId: string): Promise<GuestSubmission[]> {
    const rows = await this.prisma.guestCheckIn.findMany({
      where: { visitId },
      include: { student: { select: { id: true, fullName: true } } },
      // Ties (same instant) fall back to insertion order.
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      seatNumber: r.seatNumber,
      status: r.status === 'LATE' ? 'LATE' : 'PRESENT',
      minutesLate: r.minutesLate,
      submittedAt: r.submittedAt.toISOString(),
      location: {
        latitude: r.latitude,
        longitude: r.longitude,
        accuracyMeters: r.accuracyMeters,
        distanceMeters: r.distanceMeters,
      },
      outcome: r.outcome,
      student: r.student,
      nameMatches: r.nameMatches,
    }));
  }
}
