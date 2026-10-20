import { Injectable } from '@nestjs/common';
import {
  type ApproveRequest,
  composeFullName,
  type FieldChange,
  type ListProfileChangesResponse,
  type ListRequestsQuery,
  NAME_PARTS,
  type OwnProfileChange,
  type ProfileChangeReview,
  PROTECTED_PROFILE_FIELDS,
  type ProtectedProfileField,
  type SubmitProfileChangeRequest,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { ApiException, Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import {
  type Prisma,
  type ProfileChangeRequest,
  type StudentProfile,
} from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { profileChangeDecidedEmail } from './student-emails';
import { StudentErrors } from './student-errors';
import { studentSnapshot } from './student-mapping';
import { rethrowStudentConflict } from './students.service';

type Values = Partial<Record<ProtectedProfileField, string | null>>;

const protectedValues = (record: StudentProfile): Values =>
  Object.fromEntries(PROTECTED_PROFILE_FIELDS.map((key) => [key, record[key]]));

const changesOf = (current: Values, proposed: Values): FieldChange[] =>
  PROTECTED_PROFILE_FIELDS.filter((key) => key in proposed).map((key) => ({
    field: key,
    from: current[key] ?? null,
    to: proposed[key] ?? null,
  }));

type RequestWithStudent = ProfileChangeRequest & {
  student: StudentProfile;
  decidedBy: { displayName: string } | null;
};

/**
 * Protected profile changes (§4.4). Identity fields — the name parts and the
 * seat number — never change on the student's say-so: the student submits a
 * request, a reviewer with `profile_changes.decide` approves (applied atomically)
 * or rejects it with a reason. Students never see who decided.
 */
@Injectable()
export class ProfileChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
  ) {}

  private toOwn(request: ProfileChangeRequest, live?: StudentProfile): OwnProfileChange {
    const proposed = request.proposed as Values;
    // While pending, compare against the record as it is now; afterwards, as it was.
    const current =
      request.status === 'PENDING' && live ? protectedValues(live) : (request.current as Values);
    return {
      id: request.id,
      status: request.status,
      changes: changesOf(current, proposed),
      note: request.note,
      createdAt: request.createdAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
      decisionReason: request.decisionReason,
    };
  }

  private toReview(request: RequestWithStudent): ProfileChangeReview {
    return {
      ...this.toOwn(request, request.student),
      student: {
        id: request.student.id,
        seatNumber: request.student.seatNumber,
        fullName: request.student.fullName,
      },
      decidedBy: request.decidedBy ? { name: request.decidedBy.displayName } : null,
    };
  }

  private async ownRecord(userId: string): Promise<StudentProfile> {
    const record = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!record) throw Errors.notFound('Student record');
    return record;
  }

  /* ───────────────────────────── the student ───────────────────────────── */

  async listOwn(userId: string): Promise<OwnProfileChange[]> {
    const record = await this.ownRecord(userId);
    const requests = await this.prisma.profileChangeRequest.findMany({
      where: { studentId: record.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return requests.map((r) => this.toOwn(r, record));
  }

  async submit(
    principal: AuthPrincipal,
    input: SubmitProfileChangeRequest,
    context: RequestContext,
  ): Promise<OwnProfileChange> {
    const record = await this.ownRecord(principal.userId);
    const current = protectedValues(record);
    const proposed: Values = {};
    for (const key of PROTECTED_PROFILE_FIELDS) {
      const value = input[key];
      if (value !== undefined && value !== current[key]) proposed[key] = value;
    }
    if (Object.keys(proposed).length === 0) throw StudentErrors.noChanges();

    // A record imported with only a full name cannot take one part on its own.
    const touchesName = NAME_PARTS.some((key) => key in proposed);
    if (touchesName && record.firstName === null && NAME_PARTS.some((key) => !input[key])) {
      throw new ApiException(400, 'VALIDATION_FAILED', 'Give all four name parts', {
        details: Object.fromEntries(
          NAME_PARTS.filter((key) => !input[key]).map((key) => [key, ['NAME_REQUIRED']]),
        ),
      });
    }

    try {
      const request = await this.prisma.$transaction(async (tx) => {
        const created = await tx.profileChangeRequest.create({
          data: {
            studentId: record.id,
            requestedById: principal.userId,
            current: current,
            proposed: proposed,
            note: input.note,
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'profile_change.submitted',
            resourceType: 'profile_change_request',
            resourceId: created.id,
            outcome: 'SUCCESS',
            before: current,
            after: proposed,
            metadata: { studentId: record.id },
            context,
          },
          tx,
        );
        return created;
      });
      return this.toOwn(request, record);
    } catch (error) {
      if (isUniqueViolation(error, 'profile_change_requests_one_pending')) {
        throw StudentErrors.profileChangePending();
      }
      throw error;
    }
  }

  async cancel(
    principal: AuthPrincipal,
    id: string,
    context: RequestContext,
  ): Promise<OwnProfileChange> {
    const record = await this.ownRecord(principal.userId);
    const request = await this.prisma.profileChangeRequest.findFirst({
      where: { id, studentId: record.id },
    });
    if (!request) throw Errors.notFound('Request');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.profileChangeRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });
      if (changed.count !== 1) throw StudentErrors.alreadyDecided();
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'profile_change.cancelled',
          resourceType: 'profile_change_request',
          resourceId: id,
          outcome: 'SUCCESS',
          metadata: { studentId: record.id },
          context,
        },
        tx,
      );
    });
    const fresh = await this.prisma.profileChangeRequest.findUniqueOrThrow({ where: { id } });
    return this.toOwn(fresh, record);
  }

  /* ───────────────────────────── reviewers ───────────────────────────── */

  private readonly include = {
    student: true,
    decidedBy: { select: { displayName: true } },
  } as const satisfies Prisma.ProfileChangeRequestInclude;

  async list(query: ListRequestsQuery): Promise<ListProfileChangesResponse> {
    const where: Prisma.ProfileChangeRequestWhereInput = query.status
      ? { status: query.status }
      : {};
    const total = await this.prisma.profileChangeRequest.count({ where });
    const items = await this.prisma.profileChangeRequest.findMany({
      where,
      include: this.include,
      orderBy: [{ createdAt: query.status === 'PENDING' ? 'asc' : 'desc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      items: items.map((r) => this.toReview(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(id: string): Promise<ProfileChangeReview> {
    const request = await this.prisma.profileChangeRequest.findUnique({
      where: { id },
      include: this.include,
    });
    if (!request) throw Errors.notFound('Request');
    return this.toReview(request);
  }

  /** Applies the proposed values in the same transaction that records the decision. */
  async approve(
    principal: AuthPrincipal,
    id: string,
    input: ApproveRequest,
    context: RequestContext,
  ): Promise<ProfileChangeReview> {
    let studentEmail: string | null;
    try {
      studentEmail = await this.prisma.$transaction(async (tx) => {
        const decided = await tx.profileChangeRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            decidedAt: new Date(),
            decidedById: principal.userId,
            decisionReason: input.comment ?? null,
          },
        });
        if (decided.count !== 1) {
          if (!(await tx.profileChangeRequest.findUnique({ where: { id } }))) {
            throw Errors.notFound('Request');
          }
          throw StudentErrors.alreadyDecided();
        }
        const request = await tx.profileChangeRequest.findUniqueOrThrow({ where: { id } });
        const before = await tx.studentProfile.findUniqueOrThrow({
          where: { id: request.studentId },
        });
        const proposed = request.proposed as Values;

        const data: Prisma.StudentProfileUpdateInput = {};
        if (proposed.seatNumber && proposed.seatNumber !== before.seatNumber) {
          const clash = await tx.studentProfile.findUnique({
            where: { seatNumber: proposed.seatNumber },
          });
          if (clash) throw StudentErrors.seatTaken();
          data.seatNumber = proposed.seatNumber;
        }
        if (NAME_PARTS.some((key) => key in proposed)) {
          const parts = Object.fromEntries(
            NAME_PARTS.map((key) => [key, key in proposed ? (proposed[key] ?? null) : before[key]]),
          ) as Record<(typeof NAME_PARTS)[number], string | null>;
          Object.assign(data, parts, { fullName: composeFullName(parts) });
        }
        const after = await tx.studentProfile.update({ where: { id: before.id }, data });
        const account = before.userId
          ? await tx.user.update({
              where: { id: before.userId },
              data: { displayName: after.fullName },
            })
          : null;
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'profile_change.approved',
            resourceType: 'profile_change_request',
            resourceId: id,
            outcome: 'SUCCESS',
            reason: input.comment ?? null,
            before: studentSnapshot(before),
            after: studentSnapshot(after),
            metadata: { studentId: before.id },
            context,
          },
          tx,
        );
        return account?.email ?? null;
      });
    } catch (error) {
      rethrowStudentConflict(error);
    }
    this.notify(studentEmail, true, input.comment ?? null);
    return this.detail(id);
  }

  async reject(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<ProfileChangeReview> {
    const request = await this.prisma.profileChangeRequest.findUnique({
      where: { id },
      include: { student: { include: { user: true } } },
    });
    if (!request) throw Errors.notFound('Request');
    await this.prisma.$transaction(async (tx) => {
      const decided = await tx.profileChangeRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          decidedAt: new Date(),
          decidedById: principal.userId,
          decisionReason: reason,
        },
      });
      if (decided.count !== 1) throw StudentErrors.alreadyDecided();
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'profile_change.rejected',
          resourceType: 'profile_change_request',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          before: request.current as Record<string, unknown>,
          after: request.proposed as Record<string, unknown>,
          metadata: { studentId: request.studentId },
          context,
        },
        tx,
      );
    });
    this.notify(request.student.user?.email ?? null, false, reason);
    return this.detail(id);
  }

  private notify(email: string | null, approved: boolean, reason: string | null): void {
    if (!email) return;
    const content = profileChangeDecidedEmail(approved, reason, this.config.get('WEB_APP_URL'));
    this.background.run('profile change decision email', () =>
      this.mail.send({ to: email, subject: content.subject, text: content.text }),
    );
  }
}
