import { Injectable } from '@nestjs/common';
import {
  type AssignMembersRequest,
  type AssignMembersResponse,
  type CreateGroupRequest,
  type Group,
  type GroupDetail,
  type GroupRef,
  type RemoveMemberRequest,
  type UpdateGroupRequest,
} from '@ftms/core';
import { type AuditActor, AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { dbViolation, isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { type MembershipSource, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StudentErrors } from './student-errors';

const ACTIVE_COUNT = {
  _count: { select: { memberships: { where: { endedAt: null } } } },
} as const satisfies Prisma.TrainingGroupInclude;

type GroupWithCount = Prisma.TrainingGroupGetPayload<{ include: typeof ACTIVE_COUNT }>;

const toGroup = (group: GroupWithCount): Group => ({
  id: group.id,
  name: group.name,
  description: group.description,
  archived: group.archivedAt !== null,
  memberCount: group._count.memberships,
  createdAt: group.createdAt.toISOString(),
});

const ref = (group: { id: string; name: string } | null | undefined): GroupRef | null =>
  group ? { id: group.id, name: group.name } : null;

export interface MoveResult {
  before: GroupRef | null;
  after: GroupRef | null;
  changed: boolean;
}

/**
 * Training groups and memberships (§5). One active group per student is
 * guaranteed by a partial unique index; this service checks the same rules up
 * front so callers get precise errors, and maps races onto them.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeArchived: boolean): Promise<Group[]> {
    const groups = await this.prisma.trainingGroup.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: ACTIVE_COUNT,
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return groups.map(toGroup);
  }

  private async load(id: string): Promise<GroupWithCount> {
    const group = await this.prisma.trainingGroup.findUnique({
      where: { id },
      include: ACTIVE_COUNT,
    });
    if (!group) throw Errors.notFound('Group');
    return group;
  }

  async detail(id: string): Promise<GroupDetail> {
    const group = await this.load(id);
    const memberships = await this.prisma.groupMembership.findMany({
      where: { groupId: id, endedAt: null },
      include: { student: true },
      orderBy: { student: { fullName: 'asc' } },
    });
    return {
      ...toGroup(group),
      members: memberships.map((m) => ({
        studentId: m.studentId,
        seatNumber: m.student.seatNumber,
        fullName: m.student.fullName,
        since: m.startedAt.toISOString(),
        hasAccount: m.student.userId !== null,
      })),
    };
  }

  async create(
    principal: AuthPrincipal,
    input: CreateGroupRequest,
    context: RequestContext,
  ): Promise<Group> {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const group = await tx.trainingGroup.create({
          data: { name: input.name, description: input.description, createdById: principal.userId },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'group.created',
            resourceType: 'group',
            resourceId: group.id,
            outcome: 'SUCCESS',
            after: { name: group.name, description: group.description },
            context,
          },
          tx,
        );
        return group.id;
      });
      return toGroup(await this.load(id));
    } catch (error) {
      if (isUniqueViolation(error, 'training_groups_name_key'))
        throw StudentErrors.groupNameTaken();
      throw error;
    }
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateGroupRequest,
    context: RequestContext,
  ): Promise<Group> {
    const before = await this.load(id);
    const data: Prisma.TrainingGroupUpdateInput = {};
    if (input.name !== undefined && input.name !== before.name) data.name = input.name;
    if (input.description !== undefined && input.description !== before.description) {
      data.description = input.description;
    }
    if (Object.keys(data).length === 0) return toGroup(before);
    try {
      await this.prisma.$transaction(async (tx) => {
        const after = await tx.trainingGroup.update({ where: { id }, data });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'group.updated',
            resourceType: 'group',
            resourceId: id,
            outcome: 'SUCCESS',
            before: { name: before.name, description: before.description },
            after: { name: after.name, description: after.description },
            context,
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, 'training_groups_name_key'))
        throw StudentErrors.groupNameTaken();
      throw error;
    }
    return toGroup(await this.load(id));
  }

  /** Archived groups keep their history but accept no members; only empty groups can be archived. */
  async setArchived(
    principal: AuthPrincipal,
    id: string,
    archived: boolean,
    context: RequestContext,
  ): Promise<Group> {
    const group = await this.load(id);
    if ((group.archivedAt !== null) === archived) return toGroup(group);
    if (archived && group._count.memberships > 0) throw StudentErrors.groupNotEmpty();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.trainingGroup.update({
          where: { id },
          data: { archivedAt: archived ? new Date() : null },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: archived ? 'group.archived' : 'group.restored',
            resourceType: 'group',
            resourceId: id,
            outcome: 'SUCCESS',
            before: { archived: !archived },
            after: { archived },
            metadata: { name: group.name },
            context,
          },
          tx,
        );
      });
    } catch (error) {
      if (dbViolation(error)?.kind === 'check') throw StudentErrors.groupNotEmpty();
      throw error;
    }
    return toGroup(await this.load(id));
  }

  /* ─────────────────────────────── membership ─────────────────────────────── */

  /**
   * Puts one student into `groupId` (or no group, with `null`) inside the caller's
   * transaction: ends the active membership, then starts the new one — never two
   * active rows, never a partial move. Writes the audit entry. The caller has
   * already checked permissions.
   */
  async moveInTx(
    tx: Prisma.TransactionClient,
    params: {
      studentId: string;
      groupId: string | null;
      source: MembershipSource;
      actor: AuditActor | null;
      reason?: string | null;
      context?: RequestContext | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<MoveResult> {
    const active = await tx.groupMembership.findFirst({
      where: { studentId: params.studentId, endedAt: null },
    });
    const beforeGroup = active
      ? await tx.trainingGroup.findUniqueOrThrow({ where: { id: active.groupId } })
      : null;
    if ((active?.groupId ?? null) === params.groupId) {
      return { before: ref(beforeGroup), after: ref(beforeGroup), changed: false };
    }

    let afterGroup: { id: string; name: string; archivedAt: Date | null } | null = null;
    if (params.groupId) {
      afterGroup = await tx.trainingGroup.findUnique({ where: { id: params.groupId } });
      if (!afterGroup) throw Errors.notFound('Group');
      if (afterGroup.archivedAt) throw StudentErrors.groupArchived();
    }

    const now = new Date();
    if (active) {
      await tx.groupMembership.update({
        where: { id: active.id },
        data: { endedAt: now, endedById: params.actor?.id ?? null },
      });
    }
    if (afterGroup) {
      await tx.groupMembership.create({
        data: {
          studentId: params.studentId,
          groupId: afterGroup.id,
          source: params.source,
          startedAt: now,
          assignedById: params.actor?.id ?? null,
        },
      });
    }
    const result: MoveResult = { before: ref(beforeGroup), after: ref(afterGroup), changed: true };
    await this.audit.record(
      {
        actor: params.actor,
        action: !result.before
          ? 'group.member_added'
          : !result.after
            ? 'group.member_removed'
            : 'group.member_moved',
        resourceType: 'student',
        resourceId: params.studentId,
        outcome: 'SUCCESS',
        reason: params.reason ?? null,
        before: { group: result.before },
        after: { group: result.after },
        metadata: { source: params.source, ...params.metadata },
        context: params.context,
      },
      tx,
    );
    return result;
  }

  /** Maps a race on the one-active-group index to the same error as the up-front check. */
  private rethrowMembership(error: unknown, studentIds: string[]): never {
    if (isUniqueViolation(error, 'group_memberships_one_active_per_student')) {
      throw StudentErrors.inOtherGroup(studentIds);
    }
    const violation = dbViolation(error);
    if (violation?.kind === 'check' && /archived/.test(violation.message ?? '')) {
      throw StudentErrors.groupArchived();
    }
    throw error;
  }

  async assign(
    principal: AuthPrincipal,
    groupId: string,
    input: AssignMembersRequest,
    context: RequestContext,
  ): Promise<AssignMembersResponse> {
    const group = await this.load(groupId);
    if (group.archivedAt) throw StudentErrors.groupArchived();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const students = await tx.studentProfile.findMany({
            where: { id: { in: input.studentIds } },
            select: { id: true },
          });
          if (students.length !== input.studentIds.length) throw Errors.notFound('Student');
          const active = await tx.groupMembership.findMany({
            where: { studentId: { in: input.studentIds }, endedAt: null },
          });
          const elsewhere = active.filter((m) => m.groupId !== groupId).map((m) => m.studentId);
          if (elsewhere.length > 0 && !input.moveFromOtherGroup) {
            throw StudentErrors.inOtherGroup(elsewhere);
          }
          const counts: AssignMembersResponse = { added: 0, moved: 0, alreadyMembers: 0 };
          for (const studentId of input.studentIds) {
            const result = await this.moveInTx(tx, {
              studentId,
              groupId,
              source: 'MANUAL',
              actor: actorOf(principal),
              reason: input.reason,
              context,
            });
            if (!result.changed) counts.alreadyMembers += 1;
            else if (result.before) counts.moved += 1;
            else counts.added += 1;
          }
          return counts;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      this.rethrowMembership(error, input.studentIds);
    }
  }

  async removeMember(
    principal: AuthPrincipal,
    groupId: string,
    studentId: string,
    input: RemoveMemberRequest,
    context: RequestContext,
  ): Promise<void> {
    await this.load(groupId);
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.groupMembership.findFirst({
        where: { studentId, groupId, endedAt: null },
      });
      if (!active) throw Errors.notFound('Membership');
      await this.moveInTx(tx, {
        studentId,
        groupId: null,
        source: 'MANUAL',
        actor: actorOf(principal),
        reason: input.reason,
        context,
      });
    });
  }

  /** Sets one student's group (or none) — used from the student record page. */
  async setStudentGroup(
    principal: AuthPrincipal,
    studentId: string,
    groupId: string | null,
    reason: string | undefined,
    context: RequestContext,
  ): Promise<MoveResult> {
    const exists = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { id: true },
    });
    if (!exists) throw Errors.notFound('Student');
    try {
      return await this.prisma.$transaction((tx) =>
        this.moveInTx(tx, {
          studentId,
          groupId,
          source: 'MANUAL',
          actor: actorOf(principal),
          reason,
          context,
        }),
      );
    } catch (error) {
      this.rethrowMembership(error, [studentId]);
    }
  }
}
