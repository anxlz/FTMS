import { Injectable } from '@nestjs/common';
import {
  type CreateScheduleExceptionRequest,
  type CreateScheduleRequest,
  type ExceptionChangeResult,
  type LocalDate,
  type LocalTime,
  minutesOf,
  type Schedule,
  type ScheduleChangeResult,
  type ScheduleException,
  todayIn,
  type UpdateScheduleRequest,
  visitPhase,
  weeklyOccurrences,
  zonedToUtc,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import {
  type Prisma,
  type TrainingProgram,
  type TrainingSchedule,
} from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { byName, fromDbDate, fromDbTime, sameSet, timingOf, toDbDate, toDbTime } from './db-values';
import { planOccurrences } from './occurrences';
import { ProgramService, toProgram } from './program.service';
import { SchedulingErrors } from './scheduling-errors';
import { VisitsService } from './visits.service';

type Tx = Prisma.TransactionClient;

/** A schedule's definition as wall-clock values. */
interface Definition {
  title: string;
  weekdays: number[];
  startTime: LocalTime;
  endTime: LocalTime | null;
  startsOn: LocalDate;
  endsOn: LocalDate;
  locationName: string | null;
}

const definitionOf = (s: TrainingSchedule): Definition => ({
  title: s.title,
  weekdays: [...s.weekdays].sort((a, b) => a - b),
  startTime: fromDbTime(s.startTime),
  endTime: s.endTime ? fromDbTime(s.endTime) : null,
  startsOn: fromDbDate(s.startsOn),
  endsOn: fromDbDate(s.endsOn),
  locationName: s.locationName,
});

const SCHEDULE_INCLUDE = {
  groups: { select: { group: { select: { id: true, name: true } } } },
  _count: { select: { visits: true } },
} as const satisfies Prisma.TrainingScheduleInclude;

type ScheduleRow = Prisma.TrainingScheduleGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

const EXCEPTION_INCLUDE = {
  schedule: { select: { id: true, title: true } },
  createdBy: { select: { displayName: true } },
  _count: { select: { cancelledVisits: true } },
} as const satisfies Prisma.ScheduleExceptionInclude;

type ExceptionRow = Prisma.ScheduleExceptionGetPayload<{ include: typeof EXCEPTION_INCLUDE }>;

const toException = (e: ExceptionRow): ScheduleException => ({
  id: e.id,
  date: fromDbDate(e.date),
  schedule: e.schedule,
  reason: e.reason,
  cancelledVisits: e._count.cancelledVisits,
  createdAt: e.createdAt.toISOString(),
  createdBy: e.createdBy?.displayName ?? null,
});

/** Fields whose change matters to students (a title alone does not). */
const SIGNIFICANT: (keyof Definition)[] = [
  'weekdays',
  'startTime',
  'endTime',
  'startsOn',
  'endsOn',
  'locationName',
];

/**
 * Recurring weekly schedules and their exceptions (§6.1, §11.2). The
 * definition is kept apart from its sessions: every occurrence is a visit row
 * (`schedule_id` + `occurrence_date`), so one occurrence can be changed or
 * cancelled without touching the definition, and changing the definition
 * only re-plans sessions that have not started and were not changed on their own.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly programs: ProgramService,
    private readonly visits: VisitsService,
  ) {}

  /* ─────────────────────────── reading ─────────────────────────── */

  async list(includeEnded: boolean): Promise<Schedule[]> {
    const program = await this.prisma.trainingProgram.findFirst({ where: { isCurrent: true } });
    if (!program) return [];
    const rows = await this.prisma.trainingSchedule.findMany({
      where: { programId: program.id, ...(includeEnded ? {} : { endedAt: null }) },
      include: SCHEDULE_INCLUDE,
      orderBy: [{ endedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    });
    return this.toSchedules(rows);
  }

  private async get(id: string): Promise<Schedule> {
    const row = await this.prisma.trainingSchedule.findUniqueOrThrow({
      where: { id },
      include: SCHEDULE_INCLUDE,
    });
    const schedules = await this.toSchedules([row]);
    return schedules[0] as Schedule;
  }

  private async toSchedules(rows: ScheduleRow[]): Promise<Schedule[]> {
    const upcoming = await this.prisma.trainingVisit.groupBy({
      by: ['scheduleId'],
      where: {
        scheduleId: { in: rows.map((r) => r.id) },
        status: 'SCHEDULED',
        startsAt: { gt: new Date() },
      },
      _count: { _all: true },
    });
    const upcomingOf = new Map(upcoming.map((u) => [u.scheduleId, u._count._all]));
    return rows.map((row) => ({
      id: row.id,
      ...definitionOf(row),
      groups: byName(row.groups.map((g) => g.group)),
      endedAt: row.endedAt?.toISOString() ?? null,
      endReason: row.endReason,
      visitCount: row._count.visits,
      upcomingCount: upcomingOf.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ─────────────────────────── shared rules ─────────────────────────── */

  /**
   * `schedule.manage` covers every schedule. `schedule.group.manage` covers
   * group-specific ones only: a schedule for every active group is the
   * training-wide schedule (§3.2, §3.3).
   */
  private async assertScope(tx: Tx, principal: AuthPrincipal, groupIds: string[]): Promise<void> {
    if (principal.permissions.has('schedule.manage')) return;
    if (!principal.permissions.has('schedule.group.manage')) throw Errors.forbidden();
    const active = await tx.trainingGroup.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    if (active.length > 0 && active.every((g) => groupIds.includes(g.id))) {
      throw SchedulingErrors.trainingWide();
    }
  }

  private async lockSchedule(tx: Tx, id: string): Promise<TrainingSchedule> {
    await tx.$queryRaw`SELECT 1 FROM "training_schedules" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const schedule = await tx.trainingSchedule.findUnique({ where: { id } });
    if (!schedule) throw Errors.notFound('Schedule');
    return schedule;
  }

  private async groupIdsOf(tx: Tx, scheduleId: string): Promise<string[]> {
    const rows = await tx.scheduleGroup.findMany({
      where: { scheduleId },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }

  /** Dates of the definition whose check-in has not opened yet. */
  private upcomingDates(program: TrainingProgram, def: Definition, now: Date): LocalDate[] {
    const today = todayIn(program.timeZone, now);
    const from = def.startsOn > today ? def.startsOn : today;
    if (from > def.endsOn) return [];
    const opensBefore = program.checkInOpensMinutes * 60_000;
    return weeklyOccurrences({ startsOn: from, endsOn: def.endsOn, weekdays: def.weekdays }).filter(
      (date) =>
        zonedToUtc(date, def.startTime, program.timeZone).getTime() - opensBefore > now.getTime(),
    );
  }

  /** Days off that apply to this schedule: its own and the program-wide ones. */
  private async exceptionsFor(
    tx: Tx,
    programId: string,
    scheduleId: string,
  ): Promise<Map<LocalDate, { id: string; reason: string }>> {
    const rows = await tx.scheduleException.findMany({
      where: { programId, OR: [{ scheduleId: null }, { scheduleId }] },
      select: { id: true, date: true, reason: true },
    });
    return new Map(rows.map((r) => [fromDbDate(r.date), { id: r.id, reason: r.reason }]));
  }

  /** Materializes sessions; days off are created cancelled, so removing the day off restores them. */
  private async createOccurrences(
    tx: Tx,
    principal: AuthPrincipal,
    program: TrainingProgram,
    scheduleId: string,
    def: Definition,
    dates: LocalDate[],
    groupIds: string[],
  ): Promise<number> {
    if (dates.length === 0) return 0;
    const exceptions = await this.exceptionsFor(tx, program.id, scheduleId);
    const now = new Date();
    const rows = await tx.trainingVisit.createManyAndReturn({
      data: dates.map((date) => {
        const dayOff = exceptions.get(date);
        return {
          programId: program.id,
          scheduleId,
          occurrenceDate: toDbDate(date),
          title: def.title,
          date: toDbDate(date),
          startTime: toDbTime(def.startTime),
          endTime: def.endTime ? toDbTime(def.endTime) : null,
          startsAt: zonedToUtc(date, def.startTime, program.timeZone),
          endsAt: def.endTime ? zonedToUtc(date, def.endTime, program.timeZone) : null,
          locationName: def.locationName,
          ...timingOf(program),
          createdById: principal.userId,
          updatedById: principal.userId,
          ...(dayOff
            ? {
                status: 'CANCELLED' as const,
                cancelReason: dayOff.reason,
                cancelledAt: now,
                cancelledById: principal.userId,
                cancelledByExceptionId: dayOff.id,
              }
            : {}),
        };
      }),
      select: { id: true },
    });
    await tx.visitGroup.createMany({
      data: rows.flatMap((r) => groupIds.map((groupId) => ({ visitId: r.id, groupId }))),
    });
    return rows.length;
  }

  private scheduleData(scheduleId: string, def: Definition, extra: Record<string, unknown> = {}) {
    return {
      scheduleId,
      title: def.title,
      weekdays: def.weekdays,
      startTime: def.startTime,
      endTime: def.endTime,
      startsOn: def.startsOn,
      endsOn: def.endsOn,
      locationName: def.locationName,
      ...extra,
    };
  }

  /* ─────────────────────────── schedules ─────────────────────────── */

  async create(
    principal: AuthPrincipal,
    input: CreateScheduleRequest,
    context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    const now = new Date();
    const { id, created } = await this.prisma.$transaction(async (tx) => {
      const program = await this.programs.requireCurrent(tx);
      const range = toProgram(program);
      const def: Definition = {
        title: input.title,
        weekdays: input.weekdays,
        startTime: input.startTime,
        endTime: input.endTime ?? null,
        startsOn: input.startsOn ?? range.startDate,
        endsOn: input.endsOn ?? range.endDate,
        locationName: input.locationName ?? null,
      };
      ProgramService.assertWithin(program, def.startsOn, 'startsOn');
      ProgramService.assertWithin(program, def.endsOn, 'endsOn');
      if (def.endsOn < def.startsOn) throw SchedulingErrors.invalid('endsOn', 'END_BEFORE_START');
      await this.visits.assertGroups(tx, input.groupIds);
      await this.assertScope(tx, principal, input.groupIds);

      const schedule = await tx.trainingSchedule.create({
        data: {
          programId: program.id,
          title: def.title,
          weekdays: def.weekdays,
          startTime: toDbTime(def.startTime),
          endTime: def.endTime ? toDbTime(def.endTime) : null,
          startsOn: toDbDate(def.startsOn),
          endsOn: toDbDate(def.endsOn),
          locationName: def.locationName,
          createdById: principal.userId,
          groups: { createMany: { data: input.groupIds.map((groupId) => ({ groupId })) } },
        },
      });
      const sessions = await this.createOccurrences(
        tx,
        principal,
        program,
        schedule.id,
        def,
        this.upcomingDates(program, def, now),
        input.groupIds,
      );
      const names = await this.visits.groupNames(tx, input.groupIds);
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'schedule.created',
          resourceType: 'schedule',
          resourceId: schedule.id,
          outcome: 'SUCCESS',
          after: { ...def, groups: [...names.values()] },
          metadata: { sessionsCreated: sessions },
          context,
        },
        tx,
      );
      const recipients = await this.notifications.studentAccountsIn(tx, input.groupIds);
      await this.notifications.notify(tx, recipients, {
        type: 'schedule.created',
        data: this.scheduleData(schedule.id, def, { sessions }),
        link: '/calendar',
        dedupeKey: `schedule.created:${schedule.id}`,
      });
      return { id: schedule.id, created: sessions };
    });
    return { schedule: await this.get(id), created, updated: 0, removed: 0, cancelled: 0 };
  }

  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateScheduleRequest,
    context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    const now = new Date();
    const counts = await this.prisma.$transaction(async (tx) => {
      const schedule = await this.lockSchedule(tx, id);
      if (schedule.endedAt) throw SchedulingErrors.scheduleEnded();
      const program = await tx.trainingProgram.findUniqueOrThrow({
        where: { id: schedule.programId },
      });
      const beforeGroupIds = await this.groupIdsOf(tx, id);
      await this.assertScope(tx, principal, beforeGroupIds);

      const before = definitionOf(schedule);
      const next: Definition = {
        title: input.title ?? before.title,
        weekdays: input.weekdays ?? before.weekdays,
        startTime: input.startTime ?? before.startTime,
        endTime: input.endTime === undefined ? before.endTime : input.endTime,
        startsOn: before.startsOn,
        endsOn: input.endsOn ?? before.endsOn,
        locationName:
          input.locationName === undefined ? before.locationName : input.locationName || null,
      };
      if (next.endTime && minutesOf(next.endTime) <= minutesOf(next.startTime)) {
        throw SchedulingErrors.invalid('endTime', 'END_BEFORE_START');
      }
      if (next.endsOn !== before.endsOn) {
        ProgramService.assertWithin(program, next.endsOn, 'endsOn');
        if (next.endsOn < next.startsOn) {
          throw SchedulingErrors.invalid('endsOn', 'END_BEFORE_START');
        }
      }
      const groupIds = input.groupIds ?? beforeGroupIds;
      const added = groupIds.filter((g) => !beforeGroupIds.includes(g));
      const removedGroups = beforeGroupIds.filter((g) => !groupIds.includes(g));
      await this.visits.assertGroups(tx, added);
      await this.assertScope(tx, principal, groupIds);

      const changedFields = (Object.keys(next) as (keyof Definition)[]).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]),
      );
      const groupsChanged = !sameSet(groupIds, beforeGroupIds);
      if (changedFields.length === 0 && !groupsChanged) {
        return { created: 0, updated: 0, removed: 0 };
      }

      const updatedSchedule = await tx.trainingSchedule.update({
        where: { id },
        data: {
          title: next.title,
          weekdays: next.weekdays,
          startTime: toDbTime(next.startTime),
          endTime: next.endTime ? toDbTime(next.endTime) : null,
          endsOn: toDbDate(next.endsOn),
          locationName: next.locationName,
        },
      });
      if (added.length > 0) {
        await tx.scheduleGroup.createMany({
          data: added.map((groupId) => ({ scheduleId: id, groupId })),
        });
      }
      if (removedGroups.length > 0) {
        await tx.scheduleGroup.deleteMany({
          where: { scheduleId: id, groupId: { in: removedGroups } },
        });
      }

      // Re-plan the sessions that still follow the schedule.
      const existing = await tx.trainingVisit.findMany({
        where: { scheduleId: id },
        select: {
          id: true,
          occurrenceDate: true,
          detached: true,
          startsAt: true,
          checkInOpensMinutes: true,
          checkInClosesMinutes: true,
        },
      });
      const plan = planOccurrences(
        this.upcomingDates(program, next, now),
        existing.flatMap((v) =>
          v.occurrenceDate
            ? [
                {
                  id: v.id,
                  occurrenceDate: fromDbDate(v.occurrenceDate),
                  detached: v.detached,
                  locked: visitPhase(v, now) !== 'UPCOMING',
                },
              ]
            : [],
        ),
      );
      if (plan.remove.length > 0) {
        await tx.trainingVisit.deleteMany({ where: { id: { in: plan.remove } } });
      }
      const definitionChanged = changedFields.some((f) =>
        ['title', 'startTime', 'endTime', 'locationName'].includes(f),
      );
      if (plan.keep.length > 0 && definitionChanged) {
        // The database derives each session's instants from its own date (§16.2).
        await tx.trainingVisit.updateMany({
          where: { id: { in: plan.keep } },
          data: {
            title: next.title,
            startTime: toDbTime(next.startTime),
            endTime: next.endTime ? toDbTime(next.endTime) : null,
            locationName: next.locationName,
            updatedById: principal.userId,
          },
        });
      }
      if (plan.keep.length > 0 && groupsChanged) {
        if (added.length > 0) {
          await tx.visitGroup.createMany({
            data: plan.keep.flatMap((visitId) => added.map((groupId) => ({ visitId, groupId }))),
            skipDuplicates: true,
          });
        }
        if (removedGroups.length > 0) {
          await tx.visitGroup.deleteMany({
            where: { visitId: { in: plan.keep }, groupId: { in: removedGroups } },
          });
        }
      }
      const created = await this.createOccurrences(
        tx,
        principal,
        program,
        id,
        next,
        plan.create,
        groupIds,
      );
      const updated = definitionChanged || groupsChanged ? plan.keep.length : 0;

      const names = await this.visits.groupNames(tx, [...beforeGroupIds, ...added]);
      const nameOf = (ids: string[]) => ids.map((g) => names.get(g) ?? g).sort();
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'schedule.updated',
          resourceType: 'schedule',
          resourceId: id,
          outcome: 'SUCCESS',
          reason: input.reason ?? null,
          before: {
            ...Object.fromEntries(changedFields.map((k) => [k, before[k]])),
            ...(groupsChanged ? { groups: nameOf(beforeGroupIds) } : {}),
          },
          after: {
            ...Object.fromEntries(changedFields.map((k) => [k, next[k]])),
            ...(groupsChanged ? { groups: nameOf(groupIds) } : {}),
          },
          metadata: {
            sessionsCreated: created,
            sessionsUpdated: updated,
            sessionsRemoved: plan.remove.length,
          },
          context,
        },
        tx,
      );

      const audience = await this.notifications.studentAccountsByGroup(tx, [
        ...beforeGroupIds,
        ...added,
      ]);
      const studentsOf = (ids: string[]) => ids.flatMap((g) => audience.get(g) ?? []);
      const stamp = updatedSchedule.updatedAt.getTime();
      const significant = changedFields.filter((f) => SIGNIFICANT.includes(f));
      if (significant.length > 0) {
        await this.notifications.notify(
          tx,
          studentsOf(groupIds.filter((g) => beforeGroupIds.includes(g))),
          {
            type: 'schedule.updated',
            data: this.scheduleData(id, next, { changes: significant }),
            link: '/calendar',
            dedupeKey: `schedule.updated:${id}:${stamp}`,
          },
        );
      }
      await this.notifications.notify(tx, studentsOf(added), {
        type: 'schedule.created',
        data: this.scheduleData(id, next),
        link: '/calendar',
        dedupeKey: `schedule.created:${id}:${stamp}`,
      });
      await this.notifications.notify(tx, studentsOf(removedGroups), {
        type: 'schedule.removed',
        data: this.scheduleData(id, next),
        link: '/calendar',
        dedupeKey: `schedule.removed:${id}:${stamp}`,
      });
      return { created, updated, removed: plan.remove.length };
    });
    return { schedule: await this.get(id), ...counts, cancelled: 0 };
  }

  /** Ends the schedule: its sessions that have not started are cancelled with the reason. */
  async end(
    principal: AuthPrincipal,
    id: string,
    reason: string,
    context: RequestContext,
  ): Promise<ScheduleChangeResult> {
    const now = new Date();
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const schedule = await this.lockSchedule(tx, id);
      if (schedule.endedAt) throw SchedulingErrors.scheduleEnded();
      const groupIds = await this.groupIdsOf(tx, id);
      await this.assertScope(tx, principal, groupIds);

      await tx.trainingSchedule.update({
        where: { id },
        data: { endedAt: now, endedById: principal.userId, endReason: reason },
      });
      const sessions = await tx.trainingVisit.findMany({
        where: { scheduleId: id, status: 'SCHEDULED' },
        select: { id: true, startsAt: true, checkInOpensMinutes: true, checkInClosesMinutes: true },
      });
      const upcoming = sessions.filter((v) => visitPhase(v, now) === 'UPCOMING').map((v) => v.id);
      if (upcoming.length > 0) {
        await tx.trainingVisit.updateMany({
          where: { id: { in: upcoming } },
          data: {
            status: 'CANCELLED',
            cancelReason: reason,
            cancelledAt: now,
            cancelledById: principal.userId,
            updatedById: principal.userId,
          },
        });
      }
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'schedule.ended',
          resourceType: 'schedule',
          resourceId: id,
          outcome: 'SUCCESS',
          reason,
          before: { endedAt: null },
          after: { endedAt: now.toISOString() },
          metadata: { sessionsCancelled: upcoming.length },
          context,
        },
        tx,
      );
      const recipients = await this.notifications.studentAccountsIn(tx, groupIds);
      await this.notifications.notify(tx, recipients, {
        type: 'schedule.ended',
        data: this.scheduleData(id, definitionOf(schedule), {
          reason,
          cancelled: upcoming.length,
        }),
        link: '/calendar',
        dedupeKey: `schedule.ended:${id}`,
      });
      return upcoming.length;
    });
    return { schedule: await this.get(id), created: 0, updated: 0, removed: 0, cancelled };
  }

  /* ─────────────────────────── exceptions ─────────────────────────── */

  async listExceptions(): Promise<ScheduleException[]> {
    const program = await this.prisma.trainingProgram.findFirst({ where: { isCurrent: true } });
    if (!program) return [];
    const rows = await this.prisma.scheduleException.findMany({
      where: { programId: program.id },
      include: EXCEPTION_INCLUDE,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toException);
  }

  /** Who may manage a day off: of one schedule, like the schedule; of all, `schedule.manage`. */
  private async assertExceptionScope(
    tx: Tx,
    principal: AuthPrincipal,
    scheduleId: string | null,
  ): Promise<void> {
    if (scheduleId === null) {
      if (!principal.permissions.has('schedule.manage')) throw Errors.forbidden();
      return;
    }
    await this.assertScope(tx, principal, await this.groupIdsOf(tx, scheduleId));
  }

  /** A day without training: cancels that day's upcoming sessions and tells their students. */
  async createException(
    principal: AuthPrincipal,
    input: CreateScheduleExceptionRequest,
    context: RequestContext,
  ): Promise<ExceptionChangeResult> {
    const now = new Date();
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const program = await this.programs.requireCurrent(tx);
        ProgramService.assertWithin(program, input.date, 'date');
        if (input.date < todayIn(program.timeZone, now)) throw SchedulingErrors.inPast('date');
        let scheduleTitle: string | null = null;
        if (input.scheduleId) {
          const schedule = await this.lockSchedule(tx, input.scheduleId);
          if (schedule.programId !== program.id) throw Errors.notFound('Schedule');
          if (schedule.endedAt) throw SchedulingErrors.scheduleEnded();
          scheduleTitle = schedule.title;
        }
        await this.assertExceptionScope(tx, principal, input.scheduleId ?? null);

        const exception = await tx.scheduleException.create({
          data: {
            programId: program.id,
            date: toDbDate(input.date),
            scheduleId: input.scheduleId ?? null,
            reason: input.reason,
            createdById: principal.userId,
          },
        });
        const sessions = await tx.trainingVisit.findMany({
          where: {
            programId: program.id,
            date: toDbDate(input.date),
            status: 'SCHEDULED',
            scheduleId: input.scheduleId ?? { not: null },
            schedule: { endedAt: null },
          },
          select: {
            id: true,
            startsAt: true,
            checkInOpensMinutes: true,
            checkInClosesMinutes: true,
          },
        });
        const upcoming = sessions.filter((v) => visitPhase(v, now) === 'UPCOMING').map((v) => v.id);
        const cancelled =
          upcoming.length === 0
            ? []
            : await tx.trainingVisit.updateManyAndReturn({
                where: { id: { in: upcoming } },
                data: {
                  status: 'CANCELLED',
                  cancelReason: input.reason,
                  cancelledAt: now,
                  cancelledById: principal.userId,
                  cancelledByExceptionId: exception.id,
                  updatedById: principal.userId,
                },
              });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'schedule_exception.created',
            resourceType: 'schedule_exception',
            resourceId: exception.id,
            outcome: 'SUCCESS',
            reason: input.reason,
            after: {
              date: input.date,
              schedule: scheduleTitle,
              sessionsCancelled: cancelled.length,
            },
            context,
          },
          tx,
        );
        let notified = 0;
        for (const visit of cancelled) {
          notified += await this.visits.notifyVisitGroups(tx, visit, 'visit.cancelled', {
            reason: input.reason,
          });
        }
        return { id: exception.id, affected: cancelled.length, notified };
      });
      const row = await this.prisma.scheduleException.findUniqueOrThrow({
        where: { id: result.id },
        include: EXCEPTION_INCLUDE,
      });
      return { exception: toException(row), affected: result.affected, notified: result.notified };
    } catch (error) {
      if (
        isUniqueViolation(error, 'schedule_exceptions_one_per_day') ||
        isUniqueViolation(error, 'schedule_exceptions_one_per_schedule_day')
      ) {
        throw SchedulingErrors.exceptionExists();
      }
      throw error;
    }
  }

  /** Removes a day off and restores the sessions it cancelled that have not started. */
  async removeException(
    principal: AuthPrincipal,
    id: string,
    context: RequestContext,
  ): Promise<ExceptionChangeResult> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "schedule_exceptions" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const exception = await tx.scheduleException.findUnique({ where: { id } });
      if (!exception) throw Errors.notFound('Exception');
      await this.assertExceptionScope(tx, principal, exception.scheduleId);

      const sessions = await tx.trainingVisit.findMany({
        where: { cancelledByExceptionId: id, status: 'CANCELLED', schedule: { endedAt: null } },
        select: { id: true, startsAt: true, checkInOpensMinutes: true, checkInClosesMinutes: true },
      });
      const upcoming = sessions.filter((v) => visitPhase(v, now) === 'UPCOMING').map((v) => v.id);
      const restored =
        upcoming.length === 0
          ? []
          : await tx.trainingVisit.updateManyAndReturn({
              where: { id: { in: upcoming } },
              data: {
                status: 'SCHEDULED',
                cancelReason: null,
                cancelledAt: null,
                cancelledById: null,
                cancelledByExceptionId: null,
                updatedById: principal.userId,
              },
            });
      await tx.scheduleException.delete({ where: { id } });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'schedule_exception.removed',
          resourceType: 'schedule_exception',
          resourceId: id,
          outcome: 'SUCCESS',
          before: { date: fromDbDate(exception.date), reason: exception.reason },
          metadata: { sessionsRestored: restored.length },
          context,
        },
        tx,
      );
      let notified = 0;
      for (const visit of restored) {
        notified += await this.visits.notifyVisitGroups(tx, visit, 'visit.restored', {});
      }
      return { exception: null, affected: restored.length, notified };
    });
  }
}
