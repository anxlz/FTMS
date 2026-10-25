import { Injectable } from '@nestjs/common';
import {
  type AttendanceStatus,
  type CheckInContext,
  type CheckInRequest,
  type CheckInResult,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { LIMITS } from '../auth/auth.constants';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { type Prisma, type TrainingProgram, type TrainingVisit } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../rate-limit/rate-limiter';
import { AttendanceErrors } from './attendance-errors';
import { RECORD_INCLUDE, recordSnapshot, toRecord } from './attendance-mapping';
import { AttendanceTokens } from './attendance-tokens';
import {
  assertLocation,
  assertOpen,
  locationRequirement,
  visitForToken,
  visitSummary,
} from './check-in-rules';

type Db = Prisma.TransactionClient | PrismaService;

interface Resolved {
  visit: TrainingVisit;
  program: TrainingProgram;
  studentId: string;
  groupId: string;
}

/**
 * Signed-in QR check-in (§7.2, §7.3, §8.2, §8.5, revised in Phase 8). The QR
 * token only identifies the visit; the API checks, in this order: a valid signed
 * token; the caller is an active, verified student (guards); of one of the visit's
 * groups; the visit is not cancelled; no record exists yet; the server time is
 * inside the window; the location reading satisfies the program's policy. Only
 * then is one record created — the unique key makes a concurrent duplicate fail.
 *
 * Biometrics play no part: they are an optional sign-in convenience, never an
 * attendance condition, and enabling or disabling them changes nothing here.
 */
@Injectable()
export class CheckInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: AttendanceTokens,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  private async resolve(db: Db, principal: AuthPrincipal, token: string): Promise<Resolved> {
    const { visit, program } = await visitForToken(db, this.tokens, token);
    const student = await db.studentProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (!student) throw AttendanceErrors.notInGroup();
    const membership = await db.groupMembership.findFirst({
      where: { studentId: student.id, endedAt: null },
      select: { groupId: true },
    });
    const assigned =
      membership &&
      (await db.visitGroup.findUnique({
        where: { visitId_groupId: { visitId: visit.id, groupId: membership.groupId } },
      }));
    if (!membership || !assigned) throw AttendanceErrors.notInGroup();
    return { visit, program, studentId: student.id, groupId: membership.groupId };
  }

  /** What the check-in page shows after a scan: the visit, the window, the location rule, any record. */
  async context(principal: AuthPrincipal, token: string): Promise<CheckInContext> {
    const { visit, program, studentId } = await this.resolve(this.prisma, principal, token);
    const now = this.clock.now();
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { visitId_studentId: { visitId: visit.id, studentId } },
      include: RECORD_INCLUDE,
    });
    return {
      ...visitSummary(visit, now),
      existing: existing ? toRecord(existing, false) : null,
      location: locationRequirement(visit, program),
      serverTime: now.toISOString(),
    };
  }

  private assertCanCheckIn(
    visit: TrainingVisit,
    existingStatus: AttendanceStatus | null,
    now: Date,
  ) {
    if (existingStatus && visit.status !== 'CANCELLED') {
      throw AttendanceErrors.already(existingStatus);
    }
    return assertOpen(visit, now);
  }

  private async limit(principal: AuthPrincipal): Promise<void> {
    const key = rateLimitKey('check-in-user', principal.userId);
    const state = await this.limiter.hit(key, LIMITS.checkInAttemptsPerUser.windowSeconds);
    if (state.count > LIMITS.checkInAttemptsPerUser.limit) {
      throw Errors.rateLimited(state.resetInSeconds || LIMITS.checkInAttemptsPerUser.windowSeconds);
    }
  }

  async checkIn(
    principal: AuthPrincipal,
    input: CheckInRequest,
    context: RequestContext,
  ): Promise<CheckInResult> {
    await this.limit(principal);
    const now = this.clock.now();

    // Checks without side effects first.
    const pre = await this.resolve(this.prisma, principal, input.token);
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { visitId_studentId: { visitId: pre.visit.id, studentId: pre.studentId } },
      select: { status: true },
    });
    this.assertCanCheckIn(pre.visit, existing?.status ?? null, now);
    assertLocation(input.location, pre.visit, pre.program);

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        // Serialize with cancellation/rescheduling of the visit, then re-check.
        await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${pre.visit.id}::uuid FOR SHARE`;
        const { visit, program, studentId, groupId } = await this.resolve(
          tx,
          principal,
          input.token,
        );
        const outcome = this.assertCanCheckIn(visit, null, now);
        const { reading: location, distance } = assertLocation(input.location, visit, program);
        const created = await tx.attendanceRecord.create({
          data: {
            visitId: visit.id,
            studentId,
            groupId,
            status: outcome.result,
            minutesLate: outcome.minutesLate,
            checkedInAt: now,
            source: 'QR',
            latitude: location.latitude,
            longitude: location.longitude,
            accuracyMeters: location.accuracy ?? null,
            distanceMeters: distance,
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'attendance.checked_in',
            resourceType: 'attendance',
            resourceId: created.id,
            outcome: 'SUCCESS',
            after: { visitId: visit.id, ...recordSnapshot(created) },
            metadata: { geolocation: true, distanceMeters: distance },
            context,
          },
          tx,
        );
        return created;
      });
      return { record: toRecord(record, false) };
    } catch (error) {
      if (isUniqueViolation(error, 'attendance_records_visit_id_student_id_key')) {
        const current = await this.prisma.attendanceRecord.findFirst({
          where: { visitId: pre.visit.id, studentId: pre.studentId },
          select: { status: true },
        });
        throw AttendanceErrors.already(current?.status ?? 'PRESENT');
      }
      throw error;
    }
  }
}
