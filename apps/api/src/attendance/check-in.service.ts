import { Injectable } from '@nestjs/common';
import {
  type AttendanceStatus,
  type BiometricRequirement,
  type CheckInContext,
  type CheckInRequest,
  type CheckInResult,
  type CheckInState,
  checkInWindow,
  classifyCheckIn,
  distanceMeters,
  type GeolocationPolicy,
  type WebAuthnOptionsResponse,
} from '@ftms/core';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { AuditService } from '../audit/audit.service';
import { LIMITS } from '../auth/auth.constants';
import { BiometricErrors, BiometricsService } from '../auth/biometrics/biometrics.service';
import { WebAuthnChallenges, WebAuthnSettings } from '../auth/biometrics/webauthn';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import {
  type Prisma,
  type TrainingProgram,
  type TrainingVisit,
  type WebAuthnCredential,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rateLimitKey, RateLimiter } from '../rate-limit/rate-limiter';
import { fromDbDate, fromDbTime, timingOf } from '../scheduling/db-values';
import { SchedulingErrors } from '../scheduling/scheduling-errors';
import { AttendanceErrors } from './attendance-errors';
import { RECORD_INCLUDE, recordSnapshot, toRecord } from './attendance-mapping';
import { AttendanceTokens } from './attendance-tokens';

type Db = Prisma.TransactionClient | PrismaService;

interface Resolved {
  visit: TrainingVisit;
  program: TrainingProgram;
  studentId: string;
  groupId: string;
}

/**
 * QR check-in (§7.2, §7.3, §8.2, §8.5). The QR token only identifies the visit;
 * the API checks, in this order: a valid signed token; the caller is an active,
 * verified student (guards); of one of the visit's groups; the visit is not
 * cancelled; no record exists yet; the server time is inside the window; the
 * location reading and a fresh biometric assertion bound to this account and
 * this visit — both always for a student with an enrolled device; for one
 * without, as the program's fallback policy says. Only then is one record created — the unique key
 * makes a concurrent duplicate fail.
 */
@Injectable()
export class CheckInService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: AttendanceTokens,
    private readonly biometrics: BiometricsService,
    private readonly challenges: WebAuthnChallenges,
    private readonly settings: WebAuthnSettings,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  private async resolve(db: Db, principal: AuthPrincipal, token: string): Promise<Resolved> {
    const visitId = this.tokens.verify(token);
    if (!visitId) throw AttendanceErrors.qrInvalid();
    const visit = await db.trainingVisit.findUnique({ where: { id: visitId } });
    if (!visit) throw AttendanceErrors.qrInvalid();
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
        where: { visitId_groupId: { visitId, groupId: membership.groupId } },
      }));
    if (!membership || !assigned) throw AttendanceErrors.notInGroup();
    const program = await db.trainingProgram.findUniqueOrThrow({ where: { id: visit.programId } });
    return { visit, program, studentId: student.id, groupId: membership.groupId };
  }

  private activeCredentials(userId: string, db: Db = this.prisma): Promise<WebAuthnCredential[]> {
    return db.webAuthnCredential.findMany({ where: { userId, revokedAt: null } });
  }

  private biometricRequirement(
    program: TrainingProgram,
    credentials: number,
  ): BiometricRequirement {
    if (credentials > 0) return 'REQUIRED';
    return program.biometricFallback === 'REQUIRE_BIOMETRIC'
      ? 'NOT_ENROLLED_BLOCKED'
      : 'NOT_ENROLLED_ALLOWED';
  }

  /**
   * §7.2: a student with biometrics enabled always submits the device's location
   * with the biometric confirmation; the program's policy decides it only for
   * the fallback flow of students without an enrolled device.
   */
  private geolocationRequirement(program: TrainingProgram, credentials: number): GeolocationPolicy {
    return credentials > 0 ? 'REQUIRED' : program.geolocationPolicy;
  }

  private state(visit: TrainingVisit, now: Date): CheckInState {
    const outcome = classifyCheckIn(visit.startsAt, timingOf(visit), now);
    return outcome.result === 'NOT_OPEN'
      ? 'NOT_OPEN'
      : outcome.result === 'CLOSED'
        ? 'CLOSED'
        : 'OPEN';
  }

  /** What the check-in page shows after a scan: the visit, the window, any existing record. */
  async context(principal: AuthPrincipal, token: string): Promise<CheckInContext> {
    const { visit, program, studentId } = await this.resolve(this.prisma, principal, token);
    const now = this.clock.now();
    const window = checkInWindow(visit.startsAt, timingOf(visit));
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { visitId_studentId: { visitId: visit.id, studentId } },
      include: RECORD_INCLUDE,
    });
    const credentials = await this.activeCredentials(principal.userId);
    return {
      visit: {
        id: visit.id,
        title: visit.title,
        date: fromDbDate(visit.date),
        startTime: fromDbTime(visit.startTime),
        endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
        locationName: visit.locationName,
        status: visit.status,
      },
      window: {
        state: this.state(visit, now),
        opensAt: window.opensAt.toISOString(),
        onTimeUntil: window.onTimeUntil.toISOString(),
        closesAt: window.closesAt.toISOString(),
      },
      existing: existing ? toRecord(existing, false) : null,
      requirements: {
        biometric: this.biometricRequirement(program, credentials.length),
        geolocation: this.geolocationRequirement(program, credentials.length),
      },
      serverTime: now.toISOString(),
    };
  }

  /** The checks every attempt must pass before anything else is looked at. */
  private assertCanCheckIn(
    visit: TrainingVisit,
    existingStatus: AttendanceStatus | null,
    now: Date,
  ) {
    if (visit.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
    if (existingStatus) throw AttendanceErrors.already(existingStatus);
    const outcome = classifyCheckIn(visit.startsAt, timingOf(visit), now);
    if (outcome.result === 'NOT_OPEN') {
      throw AttendanceErrors.notOpen(checkInWindow(visit.startsAt, timingOf(visit)).opensAt);
    }
    if (outcome.result === 'CLOSED') throw AttendanceErrors.closed();
    return outcome;
  }

  private async limit(principal: AuthPrincipal): Promise<void> {
    const key = rateLimitKey('check-in-user', principal.userId);
    const state = await this.limiter.hit(key, LIMITS.checkInAttemptsPerUser.windowSeconds);
    if (state.count > LIMITS.checkInAttemptsPerUser.limit) {
      throw Errors.rateLimited(state.resetInSeconds || LIMITS.checkInAttemptsPerUser.windowSeconds);
    }
  }

  /** A WebAuthn challenge bound to this student and this visit (§7.2). */
  async options(principal: AuthPrincipal, token: string): Promise<WebAuthnOptionsResponse> {
    await this.limit(principal);
    const { visit, studentId } = await this.resolve(this.prisma, principal, token);
    const existing = await this.prisma.attendanceRecord.findUnique({
      where: { visitId_studentId: { visitId: visit.id, studentId } },
      select: { status: true },
    });
    this.assertCanCheckIn(visit, existing?.status ?? null, this.clock.now());
    const credentials = await this.activeCredentials(principal.userId);
    if (credentials.length === 0) throw AttendanceErrors.biometricNotEnrolled();
    const options = await generateAuthenticationOptions({
      rpID: this.settings.rpId,
      userVerification: 'required',
      timeout: 120_000,
      allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports })),
    });
    const challengeId = await this.challenges.create('CHECK_IN', options.challenge, {
      userId: principal.userId,
      visitId: visit.id,
    });
    return { challengeId, options: options as unknown as Record<string, unknown> };
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
    const credentials = await this.activeCredentials(principal.userId);
    if (
      this.geolocationRequirement(pre.program, credentials.length) === 'REQUIRED' &&
      !input.location
    ) {
      throw AttendanceErrors.geolocationRequired();
    }
    const requirement = this.biometricRequirement(pre.program, credentials.length);
    if (requirement === 'NOT_ENROLLED_BLOCKED') throw AttendanceErrors.biometricNotEnrolled();

    // The challenge is spent before anything is written, so it is single-use even
    // when the attempt fails later.
    let expectedChallenge: string | null = null;
    if (requirement === 'REQUIRED') {
      if (!input.biometric) throw AttendanceErrors.biometricRequired();
      expectedChallenge = await this.challenges.consume(input.biometric.challengeId, 'CHECK_IN', {
        userId: principal.userId,
        visitId: pre.visit.id,
      });
      if (!expectedChallenge) throw BiometricErrors.failed();
    }

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        // Serialize with cancellation/rescheduling of the visit, then re-check.
        await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${pre.visit.id}::uuid FOR SHARE`;
        const { visit, studentId, groupId } = await this.resolve(tx, principal, input.token);
        const outcome = this.assertCanCheckIn(visit, null, now);

        let credential: WebAuthnCredential | null = null;
        if (expectedChallenge && input.biometric) {
          credential = await this.biometrics.verifyForUser(
            principal.userId,
            input.biometric.response,
            expectedChallenge,
            tx,
          );
          if (!credential) throw BiometricErrors.failed();
        }
        const location = input.location ?? null;
        const distance =
          location && visit.latitude !== null && visit.longitude !== null
            ? distanceMeters(location, { latitude: visit.latitude, longitude: visit.longitude })
            : null;
        const created = await tx.attendanceRecord.create({
          data: {
            visitId: visit.id,
            studentId,
            groupId,
            status: outcome.result,
            minutesLate: outcome.minutesLate,
            checkedInAt: now,
            source: 'QR',
            biometricVerified: credential !== null,
            credentialId: credential?.id ?? null,
            latitude: location?.latitude ?? null,
            longitude: location?.longitude ?? null,
            accuracyMeters: location?.accuracy ?? null,
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
            metadata: { geolocation: location !== null, distanceMeters: distance },
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
