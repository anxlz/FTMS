import { Injectable } from '@nestjs/common';
import {
  type CalendarQuery,
  type CalendarResponse,
  type CreateVisitRequest,
  type GroupRef,
  minutesOf,
  type UpdateVisitRequest,
  type VisitDetail,
  type VisitHistoryEntry,
  type VisitLocation,
  type VisitMutationResult,
  visitPhase,
  type VisitTiming,
  zonedToUtc,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import { type Prisma, type TrainingVisit } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { type BucketId } from '../storage/buckets';
import { FileStore } from '../storage/file-store';
import { StudentErrors } from '../students/student-errors';
import {
  fromDbDate,
  fromDbTime,
  sameSet,
  sameTiming,
  timingOf,
  toDbDate,
  toDbTime,
} from './db-values';
import { ProgramService } from './program.service';
import { SchedulingErrors } from './scheduling-errors';
import {
  auditSnapshot,
  diffSnapshots,
  notificationData,
  toVisitFile,
  toVisitSummary,
  VISIT_DETAIL_INCLUDE,
  VISIT_INCLUDE,
  visitLink,
  type VisitWithDetail,
} from './visit-mapping';

type Tx = Prisma.TransactionClient;

interface LocationColumns {
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
}

const NO_LOCATION: LocationColumns = {
  locationName: null,
  latitude: null,
  longitude: null,
  mapUrl: null,
};

/** Applies a partial location (undefined keeps, null clears) and re-checks coordinates. */
function mergeLocation(before: LocationColumns, input: VisitLocation | undefined): LocationColumns {
  if (!input) {
    return {
      locationName: before.locationName,
      latitude: before.latitude,
      longitude: before.longitude,
      mapUrl: before.mapUrl,
    };
  }
  const next: LocationColumns = {
    locationName: input.name === undefined ? before.locationName : input.name || null,
    latitude: input.latitude === undefined ? before.latitude : input.latitude,
    longitude: input.longitude === undefined ? before.longitude : input.longitude,
    mapUrl: input.mapUrl === undefined ? before.mapUrl : input.mapUrl || null,
  };
  if ((next.latitude === null) !== (next.longitude === null)) {
    throw SchedulingErrors.invalid('location.latitude', 'COORDINATES_INCOMPLETE');
  }
  return next;
}

const sameLocation = (a: LocationColumns, b: LocationColumns): boolean =>
  a.locationName === b.locationName &&
  a.latitude === b.latitude &&
  a.longitude === b.longitude &&
  a.mapUrl === b.mapUrl;

export interface StudentGroup {
  groupId: string;
  group: GroupRef;
}

/**
 * Training visits (§6.2–6.5): create, change, cancel and restore them, and read
 * calendars. Every change is audited with before/after values, and the students
 * of the affected groups — and only them — are notified in the same transaction.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly programs: ProgramService,
    private readonly files: FileStore,
    private readonly clock: Clock,
  ) {}

  /* ─────────────────────────── reading ─────────────────────────── */

  /** The student's current group (§5: at most one). */
  async studentGroup(userId: string): Promise<StudentGroup | null> {
    const membership = await this.prisma.groupMembership.findFirst({
      where: { endedAt: null, student: { userId } },
      select: { groupId: true, group: { select: { id: true, name: true } } },
    });
    return membership;
  }

  /**
   * Staff see every visit (optionally one group's); a student sees only the
   * visits of their current group (§6.2, §9.4).
   */
  async calendar(principal: AuthPrincipal, query: CalendarQuery): Promise<CalendarResponse> {
    const where: Prisma.TrainingVisitWhereInput = {
      date: { gte: toDbDate(query.from), lte: toDbDate(query.to) },
      ...(query.status ? { status: query.status } : {}),
    };
    let group: GroupRef | null = null;
    if (principal.role === 'STUDENT') {
      const membership = await this.studentGroup(principal.userId);
      if (!membership) return { from: query.from, to: query.to, group: null, visits: [] };
      group = membership.group;
      where.groups = { some: { groupId: membership.groupId } };
    } else if (query.group) {
      where.groups = { some: { groupId: query.group } };
    }
    const visits = await this.prisma.trainingVisit.findMany({
      where,
      include: VISIT_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { title: 'asc' }],
    });
    const now = this.clock.now();
    return {
      from: query.from,
      to: query.to,
      group,
      visits: visits.map((v) => toVisitSummary(v, now)),
    };
  }

  /** Students may open only visits of their current group; others look nonexistent. */
  async detail(principal: AuthPrincipal, id: string): Promise<VisitDetail> {
    const visit = await this.prisma.trainingVisit.findUnique({
      where: { id },
      include: VISIT_DETAIL_INCLUDE,
    });
    if (!visit) throw Errors.notFound('Visit');
    if (principal.role === 'STUDENT') {
      const membership = await this.studentGroup(principal.userId);
      if (!membership || !visit.groups.some((g) => g.group.id === membership.groupId)) {
        throw Errors.notFound('Visit');
      }
    }
    return this.toDetail(visit);
  }

  async toDetail(visit: VisitWithDetail, now = this.clock.now()): Promise<VisitDetail> {
    const link = (f: VisitWithDetail['files'][number]) =>
      this.files.link(
        f.bucket as BucketId,
        f.storagePath,
        f.contentType,
        f.kind === 'DOCUMENT' ? f.fileName : null,
      );
    const cover = visit.files.find((f) => f.kind === 'COVER') ?? null;
    const documents = visit.files.filter((f) => f.kind === 'DOCUMENT');
    const opens = visit.startsAt.getTime() - visit.checkInOpensMinutes * 60_000;
    const closes = visit.startsAt.getTime() + visit.checkInClosesMinutes * 60_000;
    return {
      ...toVisitSummary(visit, now),
      description: visit.description,
      latitude: visit.latitude,
      longitude: visit.longitude,
      mapUrl: visit.mapUrl,
      timing: timingOf(visit),
      timingOverridden: visit.timingOverridden,
      cover: cover ? toVisitFile(cover, await link(cover)) : null,
      documents: await Promise.all(documents.map(async (d) => toVisitFile(d, await link(d)))),
      detached: visit.detached,
      checkInOpensAt: new Date(opens).toISOString(),
      checkInClosesAt: new Date(closes).toISOString(),
      schedule: visit.schedule,
      program: visit.program,
      createdAt: visit.createdAt.toISOString(),
      updatedAt: visit.updatedAt.toISOString(),
    };
  }

  private async staffDetail(id: string): Promise<VisitDetail> {
    const visit = await this.prisma.trainingVisit.findUniqueOrThrow({
      where: { id },
      include: VISIT_DETAIL_INCLUDE,
    });
    return this.toDetail(visit);
  }

  /** What changed, when and by whom (§6.5) — from the audit log. */
  async history(id: string): Promise<VisitHistoryEntry[]> {
    if (!(await this.prisma.trainingVisit.findUnique({ where: { id }, select: { id: true } }))) {
      throw Errors.notFound('Visit');
    }
    const rows = await this.prisma.auditLog.findMany({
      where: { resourceType: 'visit', resourceId: id, outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((row) => ({
      at: row.occurredAt.toISOString(),
      action: row.action,
      actorName: row.actorName,
      reason: row.reason,
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
    }));
  }

  /* ─────────────────────────── writing ─────────────────────────── */

  /** Locks the visit row for the rest of the transaction. */
  async lock(tx: Tx, id: string): Promise<TrainingVisit> {
    await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const visit = await tx.trainingVisit.findUnique({ where: { id } });
    if (!visit) throw Errors.notFound('Visit');
    return visit;
  }

  /** Every id must be an existing group; groups being added must not be archived. */
  async assertGroups(tx: Tx, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    const groups = await tx.trainingGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, archivedAt: true },
    });
    if (groups.length !== new Set(groupIds).size) {
      throw SchedulingErrors.invalid('groupIds', 'GROUP_NOT_FOUND');
    }
    if (groups.some((g) => g.archivedAt !== null)) throw StudentErrors.groupArchived();
  }

  async groupNames(tx: Tx, groupIds: string[]): Promise<Map<string, string>> {
    const groups = await tx.trainingGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, name: true },
    });
    return new Map(groups.map((g) => [g.id, g.name]));
  }

  async create(
    principal: AuthPrincipal,
    input: CreateVisitRequest,
    context: RequestContext,
  ): Promise<VisitMutationResult> {
    if (input.timing && !principal.permissions.has('attendance.settings.visit')) {
      throw Errors.forbidden();
    }
    const now = this.clock.now();
    const { id, notified } = await this.prisma.$transaction(async (tx) => {
      const program = await this.programs.requireCurrent(tx);
      ProgramService.assertWithin(program, input.date, 'date');
      const startsAt = zonedToUtc(input.date, input.startTime, program.timeZone);
      if (startsAt <= now) throw SchedulingErrors.inPast();
      await this.assertGroups(tx, input.groupIds);

      const defaults = timingOf(program);
      const timing: VisitTiming = input.timing ?? defaults;
      const visit = await tx.trainingVisit.create({
        data: {
          programId: program.id,
          title: input.title,
          description: input.description ?? null,
          date: toDbDate(input.date),
          startTime: toDbTime(input.startTime),
          endTime: input.endTime ? toDbTime(input.endTime) : null,
          // Derived again by the database from the wall-clock values (§16.2).
          startsAt,
          endsAt: input.endTime ? zonedToUtc(input.date, input.endTime, program.timeZone) : null,
          ...mergeLocation(NO_LOCATION, input.location),
          ...timing,
          timingOverridden: !sameTiming(timing, defaults),
          createdById: principal.userId,
          updatedById: principal.userId,
          groups: { createMany: { data: input.groupIds.map((groupId) => ({ groupId })) } },
        },
      });
      const names = await this.groupNames(tx, input.groupIds);
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'visit.created',
          resourceType: 'visit',
          resourceId: visit.id,
          outcome: 'SUCCESS',
          after: auditSnapshot(visit, [...names.values()]),
          context,
        },
        tx,
      );
      const recipients = await this.notifications.studentAccountsIn(tx, input.groupIds);
      const count = await this.notifications.notify(tx, recipients, {
        type: 'visit.created',
        data: notificationData(visit),
        link: visitLink(visit.id),
        dedupeKey: `visit.created:${visit.id}`,
      });
      return { id: visit.id, notified: count };
    });
    return { visit: await this.staffDetail(id), notified };
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateVisitRequest,
    context: RequestContext,
  ): Promise<VisitMutationResult> {
    if (input.timing !== undefined && !principal.permissions.has('attendance.settings.visit')) {
      throw Errors.forbidden();
    }
    const now = this.clock.now();
    const notified = await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
      const program = await tx.trainingProgram.findUniqueOrThrow({
        where: { id: before.programId },
      });
      const beforeGroupIds = (
        await tx.visitGroup.findMany({ where: { visitId: id }, select: { groupId: true } })
      ).map((g) => g.groupId);

      // When
      const beforeDate = fromDbDate(before.date);
      const beforeStart = fromDbTime(before.startTime);
      const beforeEnd = before.endTime ? fromDbTime(before.endTime) : null;
      const date = input.date ?? beforeDate;
      const startTime = input.startTime ?? beforeStart;
      const endTime = input.endTime === undefined ? beforeEnd : input.endTime;
      if (endTime && minutesOf(endTime) <= minutesOf(startTime)) {
        throw SchedulingErrors.invalid('endTime', 'END_BEFORE_START');
      }
      const dateChanged = date !== beforeDate;
      const timeChanged = startTime !== beforeStart || endTime !== beforeEnd;

      // Who, how
      const groupIds = input.groupIds ?? beforeGroupIds;
      const groupsChanged = !sameSet(groupIds, beforeGroupIds);
      const beforeTiming = timingOf(before);
      const defaults = timingOf(program);
      const timing =
        input.timing === undefined
          ? beforeTiming
          : input.timing === 'useDefaults'
            ? defaults
            : input.timing;
      const timingOverridden =
        input.timing === undefined ? before.timingOverridden : !sameTiming(timing, defaults);
      const timingChanged = !sameTiming(timing, beforeTiming);

      if (
        (dateChanged || timeChanged || groupsChanged || timingChanged) &&
        visitPhase(before, now) !== 'UPCOMING'
      ) {
        throw SchedulingErrors.visitHeld();
      }
      if (dateChanged || timeChanged) {
        ProgramService.assertWithin(program, date, 'date');
        if (zonedToUtc(date, startTime, program.timeZone) <= now) {
          throw SchedulingErrors.inPast(dateChanged ? 'date' : 'startTime');
        }
      }
      const added = groupIds.filter((g) => !beforeGroupIds.includes(g));
      const removed = beforeGroupIds.filter((g) => !groupIds.includes(g));
      await this.assertGroups(tx, added);

      // What, where
      const location = mergeLocation(before, input.location);
      const locationChanged = !sameLocation(location, before);
      const title = input.title ?? before.title;
      const description =
        input.description === undefined ? before.description : input.description || null;

      const changedAnything =
        dateChanged ||
        timeChanged ||
        groupsChanged ||
        timingChanged ||
        timingOverridden !== before.timingOverridden ||
        locationChanged ||
        title !== before.title ||
        description !== before.description;
      if (!changedAnything) return 0;

      const updated = await tx.trainingVisit.update({
        where: { id },
        data: {
          title,
          description,
          date: toDbDate(date),
          startTime: toDbTime(startTime),
          endTime: endTime ? toDbTime(endTime) : null,
          startsAt: zonedToUtc(date, startTime, program.timeZone),
          endsAt: endTime ? zonedToUtc(date, endTime, program.timeZone) : null,
          ...location,
          ...timing,
          timingOverridden,
          // An occurrence changed on its own no longer follows its schedule (§6.1).
          detached: before.scheduleId !== null || before.detached,
          updatedById: principal.userId,
        },
      });
      // Add before removing so the visit never concerns no group.
      if (added.length > 0) {
        await tx.visitGroup.createMany({
          data: added.map((groupId) => ({ visitId: id, groupId })),
        });
      }
      if (removed.length > 0) {
        await tx.visitGroup.deleteMany({ where: { visitId: id, groupId: { in: removed } } });
      }

      const names = await this.groupNames(tx, [...beforeGroupIds, ...added]);
      const nameOf = (ids: string[]) => ids.map((g) => names.get(g) ?? g);
      const diff = diffSnapshots(
        auditSnapshot(before, nameOf(beforeGroupIds)),
        auditSnapshot(updated, nameOf(groupIds)),
      );
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'visit.updated',
          resourceType: 'visit',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.reason ?? null,
          before: diff.before,
          after: diff.after,
          context,
        },
        tx,
      );

      // §6.5: notify affected students when the change is significant for them.
      const audience = await this.notifications.studentAccountsByGroup(tx, [
        ...beforeGroupIds,
        ...added,
      ]);
      const studentsOf = (ids: string[]) => ids.flatMap((g) => audience.get(g) ?? []);
      const stamp = updated.updatedAt.getTime();
      const changes = [
        ...(dateChanged ? ['date'] : []),
        ...(timeChanged ? ['time'] : []),
        ...(locationChanged ? ['location'] : []),
        ...(timingChanged ? ['timing'] : []),
      ];
      let count = 0;
      if (changes.length > 0) {
        count += await this.notifications.notify(
          tx,
          studentsOf(groupIds.filter((g) => beforeGroupIds.includes(g))),
          {
            type: 'visit.updated',
            data: {
              ...notificationData(updated),
              changes,
              previous: {
                date: beforeDate,
                startTime: beforeStart,
                endTime: beforeEnd,
                locationName: before.locationName,
              },
            },
            link: visitLink(id),
            dedupeKey: `visit.updated:${id}:${stamp}`,
          },
        );
      }
      count += await this.notifications.notify(tx, studentsOf(added), {
        type: 'visit.created',
        data: notificationData(updated),
        link: visitLink(id),
        dedupeKey: `visit.created:${id}:${stamp}`,
      });
      count += await this.notifications.notify(tx, studentsOf(removed), {
        type: 'visit.removed',
        data: notificationData(updated),
        link: null,
        dedupeKey: `visit.removed:${id}:${stamp}`,
      });
      return count;
    });
    return { visit: await this.staffDetail(id), notified };
  }

  /** §6.5: a cancelled visit stays visible with its status and reason. */
  async cancel(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<VisitMutationResult> {
    const notified = await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
      if (visitPhase(before, this.clock.now()) === 'FINISHED') throw SchedulingErrors.visitOver();
      const updated = await tx.trainingVisit.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: this.clock.now(),
          cancelledById: principal.userId,
          detached: before.scheduleId !== null || before.detached,
          updatedById: principal.userId,
        },
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'visit.cancelled',
          resourceType: 'visit',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          before: { status: before.status },
          after: { status: updated.status },
          context,
        },
        tx,
      );
      return this.notifyVisitGroups(tx, updated, 'visit.cancelled', { reason });
    });
    return { visit: await this.staffDetail(id), notified };
  }

  async restore(
    principal: AuthPrincipal,
    id: string,
    reason: string | undefined,
    context: RequestContext,
  ): Promise<VisitMutationResult> {
    const notified = await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status !== 'CANCELLED') throw SchedulingErrors.visitNotCancelled();
      if (visitPhase(before, this.clock.now()) === 'FINISHED') throw SchedulingErrors.visitOver();
      const updated = await tx.trainingVisit.update({
        where: { id },
        data: {
          status: 'SCHEDULED',
          cancelReason: null,
          cancelledAt: null,
          cancelledById: null,
          cancelledByExceptionId: null,
          detached: before.scheduleId !== null || before.detached,
          updatedById: principal.userId,
        },
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'visit.restored',
          resourceType: 'visit',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: reason ?? null,
          before: { status: before.status, cancelReason: before.cancelReason },
          after: { status: updated.status },
          context,
        },
        tx,
      );
      return this.notifyVisitGroups(tx, updated, 'visit.restored', {});
    });
    return { visit: await this.staffDetail(id), notified };
  }

  /** Notifies the students of every group of `visit` about a status change. */
  async notifyVisitGroups(
    tx: Tx,
    visit: TrainingVisit,
    type: 'visit.cancelled' | 'visit.restored',
    extra: Record<string, unknown>,
  ): Promise<number> {
    const groupIds = (
      await tx.visitGroup.findMany({ where: { visitId: visit.id }, select: { groupId: true } })
    ).map((g) => g.groupId);
    const recipients = await this.notifications.studentAccountsIn(tx, groupIds);
    return this.notifications.notify(tx, recipients, {
      type,
      data: { ...notificationData(visit), ...extra },
      link: visitLink(visit.id),
      dedupeKey: `${type}:${visit.id}:${visit.updatedAt.getTime()}`,
    });
  }
}
