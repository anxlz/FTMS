import { Injectable } from '@nestjs/common';
import {
  type ApproveVerificationRequest,
  composeFullName,
  type ListRequestsQuery,
  type ListVerificationsResponse,
  nameMatchKey,
  type OwnVerification,
  type SubmitVerificationRequest,
  type SubmitVerificationResponse,
  type VerificationReview,
  type VerificationReviewDetail,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { decideIdentityMatch, StudentLinkingService } from '../auth/student-linking.service';
import { Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import { type Prisma, type StudentVerificationRequest } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter, rateLimitKey } from '../rate-limit/rate-limiter';
import { GroupsService } from './groups.service';
import { accountNotVerifiedEmail, accountVerifiedEmail } from './student-emails';
import { StudentErrors } from './student-errors';
import { STUDENT_INCLUDE, studentSnapshot, toStudentRecord } from './student-mapping';
import { rethrowStudentConflict } from './students.service';

/** A pending account may resubmit its details this often per day (each try is matched automatically). */
const SUBMISSIONS_PER_DAY = 5;

const REVIEW_INCLUDE = {
  user: { select: { id: true, email: true, displayName: true } },
  decidedBy: { select: { displayName: true } },
} as const satisfies Prisma.StudentVerificationRequestInclude;

type RequestWithPeople = Prisma.StudentVerificationRequestGetPayload<{
  include: typeof REVIEW_INCLUDE;
}>;

const submitted = (r: StudentVerificationRequest) => ({
  seatNumber: r.seatNumber,
  firstName: r.firstName,
  fatherName: r.fatherName,
  grandfatherName: r.grandfatherName,
  familyName: r.familyName,
  fullName: r.fullName,
});

/**
 * §4.2 Case B: accounts whose verified signup did not match an imported record.
 * The student can correct and resubmit their details (matched automatically
 * again); a reviewer with `students.manage` links the account to a record,
 * creates one, or rejects with a reason.
 */
@Injectable()
export class VerificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly linking: StudentLinkingService,
    private readonly groups: GroupsService,
    private readonly limiter: RateLimiter,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ───────────────────────────── the student ───────────────────────────── */

  async own(principal: AuthPrincipal): Promise<OwnVerification> {
    const latest = await this.prisma.studentVerificationRequest.findFirst({
      where: { userId: principal.userId },
      orderBy: { createdAt: 'desc' },
    });
    const request = latest
      ? {
          id: latest.id,
          status: latest.status,
          submitted: submitted(latest),
          createdAt: latest.createdAt.toISOString(),
          decidedAt: latest.decidedAt?.toISOString() ?? null,
          decisionReason: latest.status === 'REJECTED' ? latest.decisionReason : null,
        }
      : null;
    if (principal.status === 'ACTIVE') return { state: 'VERIFIED', request };
    const state =
      latest?.status === 'PENDING'
        ? 'PENDING'
        : latest?.status === 'REJECTED'
          ? 'REJECTED'
          : 'NONE';
    return { state, request };
  }

  async submit(
    principal: AuthPrincipal,
    input: SubmitVerificationRequest,
    context: RequestContext,
  ): Promise<SubmitVerificationResponse> {
    if (principal.role !== 'STUDENT' || principal.status !== 'PENDING_VERIFICATION') {
      throw StudentErrors.accountAlreadyVerified();
    }
    const key = rateLimitKey('verification-submit', principal.userId);
    const state = await this.limiter.peek(key);
    if (state.count >= SUBMISSIONS_PER_DAY)
      throw Errors.rateLimited(state.resetInSeconds || 86_400);
    await this.limiter.hit(key, 86_400);

    const fullName = composeFullName(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          await tx.studentVerificationRequest.findFirst({
            where: { userId: principal.userId, status: 'PENDING' },
          })
        ) {
          throw StudentErrors.verificationPending();
        }
        const matchInput = await this.linking.matchInput(
          tx,
          principal.email,
          input.seatNumber,
          fullName,
        );
        const match = decideIdentityMatch(matchInput);
        if (match.kind === 'MATCH' && matchInput.bySeat) {
          const record = matchInput.bySeat;
          if (
            await this.linking.link(tx, {
              userId: principal.userId,
              studentId: record.id,
              email: principal.email,
            })
          ) {
            await this.audit.record(
              {
                actor: actorOf(principal),
                action: 'student.account_linked',
                resourceType: 'student',
                resourceId: record.id,
                outcome: 'SUCCESS',
                after: {
                  userId: principal.userId,
                  email: principal.email,
                  seatNumber: record.seatNumber,
                },
                metadata: { method: 'resubmitted_details' },
                context,
              },
              tx,
            );
            return { linked: true };
          }
        }
        const issue = match.kind === 'NO_MATCH' ? match.issue : 'SEAT_ALREADY_LINKED';
        const request = await tx.studentVerificationRequest.create({
          data: { userId: principal.userId, ...input, fullName, issue },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'student.verification.requested',
            resourceType: 'student_verification_request',
            resourceId: request.id,
            outcome: 'SUCCESS',
            after: { seatNumber: input.seatNumber, fullName, issue },
            metadata: { source: 'resubmission' },
            context,
          },
          tx,
        );
        return { linked: false };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'student_verification_requests_one_pending')) {
        throw StudentErrors.verificationPending();
      }
      throw error;
    }
  }

  /* ───────────────────────────── reviewers ───────────────────────────── */

  private toReview(r: RequestWithPeople): VerificationReview {
    return {
      id: r.id,
      status: r.status,
      issue: r.issue,
      account: { userId: r.user.id, email: r.user.email, displayName: r.user.displayName },
      submitted: submitted(r),
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionReason: r.decisionReason,
      decidedBy: r.decidedBy ? { name: r.decidedBy.displayName } : null,
      linkedStudentId: r.studentId,
    };
  }

  async list(query: ListRequestsQuery): Promise<ListVerificationsResponse> {
    const where: Prisma.StudentVerificationRequestWhereInput = query.status
      ? { status: query.status }
      : {};
    const total = await this.prisma.studentVerificationRequest.count({ where });
    const items = await this.prisma.studentVerificationRequest.findMany({
      where,
      include: REVIEW_INCLUDE,
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

  /** The request plus the records that could be this person's (same seat, email or name). */
  async detail(id: string): Promise<VerificationReviewDetail> {
    const request = await this.prisma.studentVerificationRequest.findUnique({
      where: { id },
      include: REVIEW_INCLUDE,
    });
    if (!request) throw Errors.notFound('Request');
    const key = nameMatchKey(request.fullName);
    const records = await this.prisma.studentProfile.findMany({
      where: {
        OR: [
          { seatNumber: request.seatNumber },
          { universityEmail: request.user.email },
          ...(key ? [{ nameKey: key }] : []),
        ],
      },
      include: STUDENT_INCLUDE,
      take: 10,
    });
    return {
      ...this.toReview(request),
      candidates: records.map((record) => ({
        ...toStudentRecord(record),
        reasons: [
          ...(record.seatNumber === request.seatNumber ? (['SEAT_NUMBER'] as const) : []),
          ...(record.universityEmail === request.user.email ? (['EMAIL'] as const) : []),
          ...(key && record.nameKey === key ? (['NAME'] as const) : []),
        ],
      })),
    };
  }

  async approve(
    principal: AuthPrincipal,
    id: string,
    input: ApproveVerificationRequest,
    context: RequestContext,
  ): Promise<VerificationReview> {
    if (input.mode === 'CREATE' && input.groupId && !principal.permissions.has('groups.manage')) {
      throw Errors.forbidden();
    }
    let email: string;
    try {
      email = await this.prisma.$transaction(async (tx) => {
        const request = await tx.studentVerificationRequest.findUnique({
          where: { id },
          include: { user: true },
        });
        if (!request) throw Errors.notFound('Request');
        if (request.status !== 'PENDING') throw StudentErrors.alreadyDecided();
        if (request.user.status !== 'PENDING_VERIFICATION')
          throw StudentErrors.accountAlreadyVerified();

        let studentId: string;
        if (input.mode === 'LINK') {
          const record = await tx.studentProfile.findUnique({ where: { id: input.studentId } });
          if (!record) throw Errors.notFound('Student');
          if (record.userId !== null) throw StudentErrors.alreadyLinked();
          const emailOwner = await tx.studentProfile.findUnique({
            where: { universityEmail: request.user.email },
          });
          if (emailOwner && emailOwner.id !== record.id) throw StudentErrors.emailTaken();
          studentId = record.id;
        } else {
          if (await tx.studentProfile.findUnique({ where: { seatNumber: request.seatNumber } })) {
            throw StudentErrors.seatTaken();
          }
          if (
            await tx.studentProfile.findUnique({ where: { universityEmail: request.user.email } })
          ) {
            throw StudentErrors.emailTaken();
          }
          const created = await tx.studentProfile.create({
            data: {
              seatNumber: request.seatNumber,
              firstName: request.firstName,
              fatherName: request.fatherName,
              grandfatherName: request.grandfatherName,
              familyName: request.familyName,
              fullName: request.fullName,
              universityEmail: request.user.email,
              createdById: principal.userId,
            },
          });
          await this.audit.record(
            {
              actor: actorOf(principal),
              action: 'student.created',
              resourceType: 'student',
              resourceId: created.id,
              outcome: 'SUCCESS',
              after: studentSnapshot(created),
              metadata: { source: 'verification', requestId: id },
              context,
            },
            tx,
          );
          studentId = created.id;
        }

        const linked = await this.linking.link(tx, {
          userId: request.userId,
          studentId,
          email: request.user.email,
          replaceRecordEmail: true,
        });
        if (!linked) throw StudentErrors.alreadyLinked();
        if (input.mode === 'CREATE' && input.groupId) {
          await this.groups.moveInTx(tx, {
            studentId,
            groupId: input.groupId,
            source: 'VERIFICATION',
            actor: actorOf(principal),
            context,
            metadata: { requestId: id },
          });
        }
        const decided = await tx.studentVerificationRequest.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            decidedAt: new Date(),
            decidedById: principal.userId,
            decisionReason: input.comment ?? null,
            studentId,
          },
        });
        if (decided.count !== 1) throw StudentErrors.alreadyDecided();
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'student.verification.approved',
            resourceType: 'student_verification_request',
            resourceId: id,
            outcome: 'SUCCESS',
            reason: input.comment ?? null,
            after: { mode: input.mode, studentId, userId: request.userId },
            context,
          },
          tx,
        );
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'student.account_linked',
            resourceType: 'student',
            resourceId: studentId,
            outcome: 'SUCCESS',
            after: { userId: request.userId, email: request.user.email },
            metadata: { method: 'review', requestId: id },
            context,
          },
          tx,
        );
        await this.notifications.notify(tx, [request.userId], {
          type: 'verification.approved',
          data: {},
          link: '/dashboard',
          dedupeKey: `verification.approved:${id}`,
        });
        return request.user.email;
      });
    } catch (error) {
      rethrowStudentConflict(error);
    }
    const content = accountVerifiedEmail(this.config.get('WEB_APP_URL'));
    this.background.run('verification approved email', () =>
      this.mail.send({ to: email, subject: content.subject, text: content.text }),
    );
    return this.reviewOf(id);
  }

  async reject(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<VerificationReview> {
    const request = await this.prisma.studentVerificationRequest.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!request) throw Errors.notFound('Request');
    await this.prisma.$transaction(async (tx) => {
      const decided = await tx.studentVerificationRequest.updateMany({
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
          action: 'student.verification.rejected',
          resourceType: 'student_verification_request',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          metadata: { userId: request.userId, seatNumber: request.seatNumber },
          context,
        },
        tx,
      );
      await this.notifications.notify(tx, [request.userId], {
        type: 'verification.rejected',
        data: { reason },
        link: '/verification',
        dedupeKey: `verification.rejected:${id}`,
      });
    });
    const content = accountNotVerifiedEmail(reason, this.config.get('WEB_APP_URL'));
    this.background.run('verification rejected email', () =>
      this.mail.send({ to: request.user.email, subject: content.subject, text: content.text }),
    );
    return this.reviewOf(id);
  }

  private async reviewOf(id: string): Promise<VerificationReview> {
    const request = await this.prisma.studentVerificationRequest.findUniqueOrThrow({
      where: { id },
      include: REVIEW_INCLUDE,
    });
    return this.toReview(request);
  }
}
