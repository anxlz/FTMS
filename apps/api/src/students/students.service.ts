import { Injectable } from '@nestjs/common';
import {
  composeFullName,
  type CreateStudentRequest,
  isUniversityEmail,
  type ListStudentsQuery,
  type ListStudentsResponse,
  nameMatchKey,
  type NameParts,
  type OwnStudentProfile,
  type StudentDetail,
  type UpdateOwnProfileRequest,
  type UpdateStudentRequest,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { SessionService } from '../auth/session.service';
import { Errors } from '../common/api-exception';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { AppConfigService } from '../config/app-config.service';
import { type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GroupsService } from './groups.service';
import { StudentErrors } from './student-errors';
import {
  STUDENT_DETAIL_INCLUDE,
  STUDENT_INCLUDE,
  studentSnapshot,
  type StudentWithRelations,
  toOwnProfile,
  toStudentDetail,
  toStudentRecord,
} from './student-mapping';

/** Columns for a name given as parts; the full name is always composed from them. */
export const nameColumns = (name: NameParts) => ({
  firstName: name.firstName,
  fatherName: name.fatherName,
  grandfatherName: name.grandfatherName,
  familyName: name.familyName,
  fullName: composeFullName(name),
});

/** Turns unique-index races into the same errors as the up-front checks. */
export function rethrowStudentConflict(error: unknown): never {
  if (isUniqueViolation(error, 'student_profiles_seat_number_key')) throw StudentErrors.seatTaken();
  if (isUniqueViolation(error, 'student_profiles_university_email_key')) {
    throw StudentErrors.emailTaken();
  }
  throw error;
}

/**
 * Student records (§4.1, §4.4). Faculty hold the authoritative data; a linked
 * account shows it. Group membership changes go through `GroupsService`.
 */
@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly groups: GroupsService,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  private async load(id: string): Promise<StudentWithRelations> {
    const record = await this.prisma.studentProfile.findUnique({
      where: { id },
      include: STUDENT_INCLUDE,
    });
    if (!record) throw Errors.notFound('Student');
    return record;
  }

  async detail(id: string): Promise<StudentDetail> {
    const record = await this.prisma.studentProfile.findUnique({
      where: { id },
      include: STUDENT_DETAIL_INCLUDE,
    });
    if (!record) throw Errors.notFound('Student');
    return toStudentDetail(record);
  }

  async list(query: ListStudentsQuery): Promise<ListStudentsResponse> {
    const q = query.q?.trim();
    const key = q ? nameMatchKey(q) : '';
    const where: Prisma.StudentProfileWhereInput = {
      ...(query.group === 'none'
        ? { memberships: { none: { endedAt: null } } }
        : query.group
          ? { memberships: { some: { groupId: query.group, endedAt: null } } }
          : {}),
      ...(query.account === 'linked'
        ? { userId: { not: null } }
        : query.account === 'unlinked'
          ? { userId: null }
          : {}),
      ...(q
        ? {
            OR: [
              { seatNumber: { contains: q.toUpperCase() } },
              { universityEmail: { contains: q.toLowerCase() } },
              ...(key ? [{ nameKey: { contains: key } }] : []),
            ],
          }
        : {}),
    };
    const total = await this.prisma.studentProfile.count({ where });
    const records = await this.prisma.studentProfile.findMany({
      where,
      include: STUDENT_INCLUDE,
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      items: records.map(toStudentRecord),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private assertUniversityEmail(email: string | null | undefined): void {
    if (email && !isUniversityEmail(email, this.config.get('UNIVERSITY_EMAIL_DOMAINS'))) {
      throw StudentErrors.notUniversityEmail();
    }
  }

  /** An email may not be another record's, nor a staff account's login. */
  private async assertEmailFree(
    tx: Prisma.TransactionClient,
    email: string,
    exceptStudentId?: string,
  ): Promise<void> {
    const record = await tx.studentProfile.findUnique({ where: { universityEmail: email } });
    if (record && record.id !== exceptStudentId) throw StudentErrors.emailTaken();
    const account = await tx.user.findUnique({ where: { email } });
    if (account && account.role !== 'STUDENT') throw StudentErrors.emailTaken();
  }

  async create(
    principal: AuthPrincipal,
    input: CreateStudentRequest,
    context: RequestContext,
  ): Promise<StudentDetail> {
    if (input.groupId && !principal.permissions.has('groups.manage')) throw Errors.forbidden();
    this.assertUniversityEmail(input.universityEmail);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        if (await tx.studentProfile.findUnique({ where: { seatNumber: input.seatNumber } })) {
          throw StudentErrors.seatTaken();
        }
        if (input.universityEmail) await this.assertEmailFree(tx, input.universityEmail);
        const record = await tx.studentProfile.create({
          data: {
            seatNumber: input.seatNumber,
            ...nameColumns(input.name),
            universityEmail: input.universityEmail ?? null,
            phone: input.phone ?? null,
            createdById: principal.userId,
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'student.created',
            resourceType: 'student',
            resourceId: record.id,
            outcome: 'SUCCESS',
            after: studentSnapshot(record),
            metadata: { source: 'manual' },
            context,
          },
          tx,
        );
        if (input.groupId) {
          await this.groups.moveInTx(tx, {
            studentId: record.id,
            groupId: input.groupId,
            source: 'MANUAL',
            actor: actorOf(principal),
            context,
          });
        }
        return record.id;
      });
    } catch (error) {
      rethrowStudentConflict(error);
    }
    return this.detail(id);
  }

  /**
   * Faculty edit authoritative fields. Seat-number changes keep uniqueness; the
   * email of a linked record is the account's verified login and is locked.
   */
  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateStudentRequest,
    context: RequestContext,
  ): Promise<StudentDetail> {
    this.assertUniversityEmail(input.universityEmail);
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.studentProfile.findUnique({ where: { id } });
        if (!before) throw Errors.notFound('Student');
        const data: Prisma.StudentProfileUncheckedUpdateInput = {};

        if (input.seatNumber !== undefined && input.seatNumber !== before.seatNumber) {
          const clash = await tx.studentProfile.findUnique({
            where: { seatNumber: input.seatNumber },
          });
          if (clash) throw StudentErrors.seatTaken();
          data.seatNumber = input.seatNumber;
        }
        if (input.name !== undefined) {
          const columns = nameColumns(input.name);
          const changed = (Object.keys(columns) as (keyof typeof columns)[]).some(
            (key) => columns[key] !== before[key],
          );
          if (changed) Object.assign(data, columns);
        }
        if (
          input.universityEmail !== undefined &&
          input.universityEmail !== before.universityEmail
        ) {
          if (before.userId !== null) throw StudentErrors.emailLocked();
          if (input.universityEmail) await this.assertEmailFree(tx, input.universityEmail, id);
          data.universityEmail = input.universityEmail;
        }
        if (input.phone !== undefined && input.phone !== before.phone) data.phone = input.phone;
        if (Object.keys(data).length === 0) throw StudentErrors.noChanges();

        const after = await tx.studentProfile.update({ where: { id }, data });
        if (before.userId && after.fullName !== before.fullName) {
          // The account shows the authoritative name.
          await tx.user.update({
            where: { id: before.userId },
            data: { displayName: after.fullName },
          });
        }
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'student.updated',
            resourceType: 'student',
            resourceId: id,
            outcome: 'SUCCESS',
            reason: input.reason ?? null,
            before: studentSnapshot(before),
            after: studentSnapshot(after),
            context,
          },
          tx,
        );
      });
    } catch (error) {
      rethrowStudentConflict(error);
    }
    return this.detail(id);
  }

  /**
   * Removes a record that no account uses. A linked record is the student's
   * identity: unlink (or suspend the account) first. The audit entry keeps a
   * full snapshot of what was deleted and by whom (§15.2).
   */
  async remove(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<void> {
    const record = await this.load(id);
    if (record.userId !== null) throw StudentErrors.linkedToAccount();
    const group = record.memberships[0]?.group;
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.studentProfile.deleteMany({ where: { id, userId: null } });
      if (deleted.count !== 1) throw StudentErrors.linkedToAccount();
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'student.deleted',
          resourceType: 'student',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          before: studentSnapshot(record, group ? { id: group.id, name: group.name } : null),
          context,
        },
        tx,
      );
    });
  }

  /**
   * Detaches a wrongly linked account (correction tool). The account goes back
   * to PENDING_VERIFICATION — it keeps no access to academic data — and every
   * session is revoked; the student can submit their details for review again.
   */
  async unlinkAccount(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<StudentDetail> {
    const record = await this.load(id);
    if (!record.user) throw Errors.notFound('Linked account');
    const user = record.user;
    await this.prisma.$transaction(async (tx) => {
      await tx.studentProfile.update({ where: { id }, data: { userId: null, linkedAt: null } });
      await tx.user.update({
        where: { id: user.id },
        data: { status: user.status === 'SUSPENDED' ? 'SUSPENDED' : 'PENDING_VERIFICATION' },
      });
      const revoked = await this.sessions.revokeAllForUser(user.id, 'account_unlinked', { tx });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'student.account_unlinked',
          resourceType: 'student',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          before: { linkedUserId: user.id, accountStatus: user.status },
          after: {
            linkedUserId: null,
            accountStatus: user.status === 'SUSPENDED' ? 'SUSPENDED' : 'PENDING_VERIFICATION',
          },
          metadata: { email: user.email, sessionsRevoked: revoked },
          context,
        },
        tx,
      );
    });
    return this.detail(id);
  }

  /* ───────────────────────────── self service ───────────────────────────── */

  private async ownRecord(userId: string): Promise<StudentWithRelations> {
    const record = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: STUDENT_INCLUDE,
    });
    if (!record) throw Errors.notFound('Student record');
    return record;
  }

  async own(userId: string): Promise<OwnStudentProfile> {
    return toOwnProfile(await this.ownRecord(userId));
  }

  /** Permitted self-service fields only (§4.4); protected fields need a request. */
  async updateOwn(
    principal: AuthPrincipal,
    input: UpdateOwnProfileRequest,
    context: RequestContext,
  ): Promise<OwnStudentProfile> {
    const record = await this.ownRecord(principal.userId);
    if (input.phone === undefined || input.phone === record.phone) return toOwnProfile(record);
    await this.prisma.$transaction(async (tx) => {
      await tx.studentProfile.update({ where: { id: record.id }, data: { phone: input.phone } });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'student.profile_updated_by_student',
          resourceType: 'student',
          resourceId: record.id,
          outcome: 'SUCCESS',
          before: { phone: record.phone },
          after: { phone: input.phone ?? null },
          context,
        },
        tx,
      );
    });
    return this.own(principal.userId);
  }
}
