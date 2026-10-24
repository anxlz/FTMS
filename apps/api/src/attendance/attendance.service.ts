import { Injectable } from '@nestjs/common';
import {
  type AttendanceOverview,
  attendanceTotals,
  type CheckInState,
  checkInWindow,
  classifyCheckIn,
  type CorrectAttendanceRequest,
  type GroupRef,
  nameMatchKey,
  type OwnAttendanceResponse,
  type VisitAttendanceQuery,
  type VisitAttendanceResponse,
  type VisitAttendanceRow,
  visitPhase,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { byName, fromDbDate, fromDbTime, timingOf } from '../scheduling/db-values';
import { SchedulingErrors } from '../scheduling/scheduling-errors';
import { AbsencesService } from './absences.service';
import { AttendanceErrors } from './attendance-errors';
import { RECORD_INCLUDE, recordSnapshot, toRecord } from './attendance-mapping';

/**
 * Attendance as faculty see it (§10.3), corrections (§8.4), the student's own
 * dashboard and history (§9) and the training-wide overview (§10.1). Every
 * figure counts only records of visits that were not cancelled.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly absences: AbsencesService,
    private readonly clock: Clock,
  ) {}

  private windowState(
    visit: {
      startsAt: Date;
      checkInOpensMinutes: number;
      graceMinutes: number;
      checkInClosesMinutes: number;
    },
    now: Date,
  ): CheckInState {
    const r = classifyCheckIn(visit.startsAt, timingOf(visit), now).result;
    return r === 'NOT_OPEN' ? 'NOT_OPEN' : r === 'CLOSED' ? 'CLOSED' : 'OPEN';
  }

  /* ─────────────────────────── faculty: one visit ─────────────────────────── */

  async visitAttendance(
    visitId: string,
    query: VisitAttendanceQuery,
  ): Promise<VisitAttendanceResponse> {
    let visit = await this.prisma.trainingVisit.findUnique({ where: { id: visitId } });
    if (!visit) throw Errors.notFound('Visit');
    const now = this.clock.now();
    // Final figures once the window has closed, even if the scheduled job lags.
    if (
      visit.status === 'SCHEDULED' &&
      !visit.absencesProcessedAt &&
      visitPhase(visit, now) === 'FINISHED'
    ) {
      await this.absences.processVisit(visitId);
      visit = await this.prisma.trainingVisit.findUniqueOrThrow({ where: { id: visitId } });
    }

    const visitGroups = await this.prisma.visitGroup.findMany({
      where: { visitId },
      select: { group: { select: { id: true, name: true } } },
    });
    const groupIds = visitGroups.map((g) => g.group.id);
    const [members, records] = await Promise.all([
      this.prisma.groupMembership.findMany({
        where: { groupId: { in: groupIds }, endedAt: null },
        select: {
          group: { select: { id: true, name: true } },
          student: { select: { id: true, fullName: true, seatNumber: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { visitId },
        include: {
          ...RECORD_INCLUDE,
          group: { select: { id: true, name: true } },
          student: { select: { id: true, fullName: true, seatNumber: true } },
        },
      }),
    ]);

    const rows = new Map<string, VisitAttendanceRow>();
    for (const m of members) {
      rows.set(m.student.id, { student: m.student, group: m.group, record: null, expected: true });
    }
    for (const r of records) {
      rows.set(r.studentId, {
        student: r.student,
        group: r.group,
        record: toRecord(r, true),
        expected: rows.has(r.studentId),
      });
    }

    const all = [...rows.values()];
    const counts = {
      expected: members.length,
      present: records.filter((r) => r.status === 'PRESENT').length,
      late: records.filter((r) => r.status === 'LATE').length,
      absent: records.filter((r) => r.status === 'ABSENT').length,
      notRecorded: all.filter((r) => r.expected && !r.record).length,
    };
    const q = query.q ? nameMatchKey(query.q) : '';
    const seat = query.q?.toUpperCase() ?? '';
    const filtered = all
      .filter((r) => !query.group || r.group?.id === query.group)
      .filter((r) =>
        !query.status
          ? true
          : query.status === 'NOT_RECORDED'
            ? r.record === null
            : r.record?.status === query.status,
      )
      .filter(
        (r) =>
          !query.q ||
          (q !== '' && nameMatchKey(r.student.fullName).includes(q)) ||
          r.student.seatNumber.includes(seat),
      )
      .sort(
        (a, b) =>
          (a.group?.name ?? '').localeCompare(b.group?.name ?? '', 'ar') ||
          a.student.fullName.localeCompare(b.student.fullName, 'ar'),
      );

    const window = checkInWindow(visit.startsAt, timingOf(visit));
    return {
      visit: {
        id: visit.id,
        title: visit.title,
        date: fromDbDate(visit.date),
        startTime: fromDbTime(visit.startTime),
        endTime: visit.endTime ? fromDbTime(visit.endTime) : null,
        status: visit.status,
        groups: byName(visitGroups.map((g) => g.group)),
        latitude: visit.latitude,
        longitude: visit.longitude,
      },
      window: {
        state: this.windowState(visit, now),
        opensAt: window.opensAt.toISOString(),
        closesAt: window.closesAt.toISOString(),
      },
      absencesProcessed: visit.absencesProcessedAt !== null,
      counts,
      rows: filtered,
    };
  }

  /**
   * §8.4: set a student's status (and minutes late) for a visit. The record
   * becomes MANUAL with who, when and why; the absence job never overwrites it,
   * and the audit log keeps the previous state.
   */
  async correct(
    principal: AuthPrincipal,
    visitId: string,
    studentId: string,
    input: CorrectAttendanceRequest,
    context: RequestContext,
  ): Promise<VisitAttendanceRow> {
    const now = this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${visitId}::uuid FOR SHARE`;
      const visit = await tx.trainingVisit.findUnique({ where: { id: visitId } });
      if (!visit) throw Errors.notFound('Visit');
      if (visit.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
      if (visitPhase(visit, now) === 'UPCOMING') throw AttendanceErrors.visitNotStarted();
      const student = await tx.studentProfile.findUnique({
        where: { id: studentId },
        select: { id: true, userId: true },
      });
      if (!student) throw Errors.notFound('Student');

      const minutesLate = input.status === 'LATE' ? (input.minutesLate ?? 1) : 0;
      const correction = {
        status: input.status,
        minutesLate,
        source: 'MANUAL' as const,
        correctedById: principal.userId,
        correctedAt: now,
        correctionReason: input.reason ?? null,
      };
      const before = await tx.attendanceRecord.findUnique({
        where: { visitId_studentId: { visitId, studentId } },
      });
      let record;
      if (before) {
        record = await tx.attendanceRecord.update({ where: { id: before.id }, data: correction });
      } else {
        const membership = await tx.groupMembership.findFirst({
          where: { studentId, endedAt: null, group: { visitGroups: { some: { visitId } } } },
          select: { groupId: true },
        });
        if (!membership) throw AttendanceErrors.studentNotInGroup();
        record = await tx.attendanceRecord.create({
          data: { visitId, studentId, groupId: membership.groupId, ...correction },
        });
      }
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'attendance.corrected',
          resourceType: 'attendance',
          resourceId: record.id,
          outcome: 'SUCCESS',
          reason: input.reason ?? null,
          before: before ? recordSnapshot(before) : null,
          after: { visitId, studentId, ...recordSnapshot(record) },
          context,
        },
        tx,
      );
      if (student.userId) {
        await this.notifications.notify(tx, [student.userId], {
          type: 'attendance.corrected',
          data: {
            visitId,
            title: visit.title,
            date: fromDbDate(visit.date),
            status: record.status,
            minutesLate: record.minutesLate,
            reason: input.reason ?? null,
          },
          link: '/attendance',
          dedupeKey: `attendance.corrected:${record.id}:${now.getTime()}`,
        });
      }
      return record.id;
    });
    const r = await this.prisma.attendanceRecord.findUniqueOrThrow({
      where: { id },
      include: {
        ...RECORD_INCLUDE,
        group: { select: { id: true, name: true } },
        student: { select: { id: true, fullName: true, seatNumber: true } },
      },
    });
    const expected =
      (await this.prisma.groupMembership.count({
        where: { studentId, endedAt: null, group: { visitGroups: { some: { visitId } } } },
      })) > 0;
    return { student: r.student, group: r.group, record: toRecord(r, true), expected };
  }

  /* ─────────────────────────── the student (§9) ─────────────────────────── */

  async own(principal: AuthPrincipal): Promise<OwnAttendanceResponse> {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (!student) return { summary: null, records: [] };
    const now = this.clock.now();
    const [program, membership] = await Promise.all([
      this.prisma.trainingProgram.findFirst({ where: { isCurrent: true } }),
      this.prisma.groupMembership.findFirst({
        where: { studentId: student.id, endedAt: null },
        select: { groupId: true },
      }),
    ]);
    const groupVisits =
      program && membership
        ? await this.prisma.trainingVisit.findMany({
            where: {
              programId: program.id,
              status: 'SCHEDULED',
              groups: { some: { groupId: membership.groupId } },
            },
            select: {
              id: true,
              startsAt: true,
              checkInOpensMinutes: true,
              checkInClosesMinutes: true,
              absencesProcessedAt: true,
            },
          })
        : [];
    // Absences of visits that just closed count at once, even if the job lags.
    const due = groupVisits.filter(
      (v) => !v.absencesProcessedAt && visitPhase(v, now) === 'FINISHED',
    );
    for (const v of due) await this.absences.processVisit(v.id);

    const records = await this.prisma.attendanceRecord.findMany({
      where: { studentId: student.id, visit: { status: 'SCHEDULED' } },
      include: { visit: true },
      orderBy: [{ visit: { startsAt: 'desc' } }],
    });
    const inProgram = program ? records.filter((r) => r.visit.programId === program.id) : [];
    const totals = attendanceTotals(
      inProgram.map((r) => r.status),
      program?.allowedAbsences ?? 0,
    );
    return {
      summary: program
        ? {
            scheduledVisits: groupVisits.length,
            upcomingVisits: groupVisits.filter((v) => visitPhase(v, now) !== 'FINISHED').length,
            ...totals,
            allowedAbsences: program.allowedAbsences,
          }
        : null,
      records: records.map((r) => ({
        visit: {
          id: r.visit.id,
          title: r.visit.title,
          date: fromDbDate(r.visit.date),
          startTime: fromDbTime(r.visit.startTime),
          endTime: r.visit.endTime ? fromDbTime(r.visit.endTime) : null,
        },
        status: r.status,
        minutesLate: r.minutesLate,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
        source: r.source,
        note: r.correctionReason,
      })),
    };
  }

  /* ─────────────────────────── training-wide (§10.1) ─────────────────────────── */

  async overview(): Promise<AttendanceOverview> {
    const program = await this.prisma.trainingProgram.findFirst({ where: { isCurrent: true } });
    const empty: AttendanceOverview = {
      visits: { total: 0, completed: 0, remaining: 0, nextSevenDays: 0 },
      records: { present: 0, late: 0, absent: 0 },
      groups: [],
    };
    if (!program) return empty;
    await this.absences.processDue(20, { programId: program.id });
    const now = this.clock.now();
    const week = now.getTime() + 7 * 86_400_000;
    const visits = await this.prisma.trainingVisit.findMany({
      where: { programId: program.id, status: 'SCHEDULED' },
      select: {
        id: true,
        startsAt: true,
        checkInOpensMinutes: true,
        checkInClosesMinutes: true,
        groups: { select: { groupId: true } },
      },
    });
    const finished = visits.filter((v) => visitPhase(v, now) === 'FINISHED');
    const [byStatus, byGroup, groups] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { visit: { programId: program.id, status: 'SCHEDULED' } },
        _count: { _all: true },
      }),
      this.prisma.attendanceRecord.groupBy({
        by: ['groupId', 'status'],
        where: { visit: { programId: program.id, status: 'SCHEDULED' } },
        _count: { _all: true },
      }),
      this.prisma.trainingGroup.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    const count = (status: string, groupId?: string) =>
      (groupId
        ? byGroup.find((g) => g.groupId === groupId && g.status === status)
        : byStatus.find((g) => g.status === status)
      )?._count._all ?? 0;
    return {
      visits: {
        total: visits.length,
        completed: finished.length,
        remaining: visits.length - finished.length,
        nextSevenDays: visits.filter(
          (v) => v.startsAt.getTime() >= now.getTime() && v.startsAt.getTime() < week,
        ).length,
      },
      records: { present: count('PRESENT'), late: count('LATE'), absent: count('ABSENT') },
      groups: byName(groups).map((group: GroupRef) => ({
        group,
        completedVisits: finished.filter((v) => v.groups.some((g) => g.groupId === group.id))
          .length,
        present: count('PRESENT', group.id),
        late: count('LATE', group.id),
        absent: count('ABSENT', group.id),
      })),
    };
  }
}
