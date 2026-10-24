import { Injectable, Logger } from '@nestjs/common';
import { visitPhase } from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../common/clock';
import { type Prisma } from '../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { fromDbDate } from '../scheduling/db-values';

export interface AbsenceRunResult {
  visits: number;
  absences: number;
  notified: number;
}

/**
 * Automatic absence processing (§8.3). After a visit's check-in window closes,
 * every student of its groups without a record gets an ABSENT record.
 *
 * Idempotent by construction: records are only ever inserted, with
 * `ON CONFLICT DO NOTHING` on the one-record-per-student-per-visit key, so a
 * second run adds nothing and an existing record — a check-in or a faculty
 * correction — is never overwritten. Cancelled visits are skipped; a visit is
 * judged by its current schedule (rescheduled visits close later).
 */
@Injectable()
export class AbsencesService {
  private readonly logger = new Logger(AbsencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly clock: Clock,
  ) {}

  /** Processes up to `limit` visits whose window has closed and that were not processed yet. */
  async processDue(
    limit = 50,
    where: Prisma.TrainingVisitWhereInput = {},
  ): Promise<AbsenceRunResult> {
    const now = this.clock.now();
    const candidates = await this.prisma.trainingVisit.findMany({
      where: { ...where, status: 'SCHEDULED', absencesProcessedAt: null, startsAt: { lt: now } },
      select: { id: true, startsAt: true, checkInOpensMinutes: true, checkInClosesMinutes: true },
      orderBy: { startsAt: 'asc' },
      take: limit * 4,
    });
    const due = candidates.filter((v) => visitPhase(v, now) === 'FINISHED').slice(0, limit);
    const total: AbsenceRunResult = { visits: 0, absences: 0, notified: 0 };
    for (const visit of due) {
      const result = await this.processVisit(visit.id);
      if (result) {
        total.visits += 1;
        total.absences += result.absences;
        total.notified += result.notified;
      }
    }
    if (total.visits > 0) {
      this.logger.log(`Absences recorded: ${total.absences} across ${total.visits} visit(s)`);
    }
    return total;
  }

  /** Null when the visit is not due (cancelled, not finished) or already processed. */
  async processVisit(visitId: string): Promise<{ absences: number; notified: number } | null> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "training_visits" WHERE "id" = ${visitId}::uuid FOR UPDATE`;
      const visit = await tx.trainingVisit.findUnique({ where: { id: visitId } });
      if (!visit || visit.status !== 'SCHEDULED' || visit.absencesProcessedAt) return null;
      if (visitPhase(visit, now) !== 'FINISHED') return null;

      const groupIds = (
        await tx.visitGroup.findMany({ where: { visitId }, select: { groupId: true } })
      ).map((g) => g.groupId);
      const members = await tx.groupMembership.findMany({
        where: { groupId: { in: groupIds }, endedAt: null },
        select: { studentId: true, groupId: true, student: { select: { userId: true } } },
      });
      const recorded = new Set(
        (
          await tx.attendanceRecord.findMany({ where: { visitId }, select: { studentId: true } })
        ).map((r) => r.studentId),
      );
      const missing = members.filter((m) => !recorded.has(m.studentId));
      const created = await tx.attendanceRecord.createManyAndReturn({
        data: missing.map((m) => ({
          visitId,
          studentId: m.studentId,
          groupId: m.groupId,
          status: 'ABSENT' as const,
          source: 'AUTOMATIC' as const,
        })),
        skipDuplicates: true,
        select: { studentId: true },
      });
      await tx.trainingVisit.updateMany({
        where: { id: visitId },
        data: { absencesProcessedAt: now },
      });
      await this.audit.record(
        {
          actor: null,
          action: 'attendance.absences_recorded',
          resourceType: 'visit',
          resourceId: visitId,
          outcome: 'SUCCESS',
          metadata: { absences: created.length, students: members.length },
        },
        tx,
      );
      const absentIds = new Set(created.map((c) => c.studentId));
      const recipients = members.flatMap((m) =>
        absentIds.has(m.studentId) && m.student.userId ? [m.student.userId] : [],
      );
      const notified = await this.notifications.notify(tx, recipients, {
        type: 'attendance.absent',
        data: { visitId, title: visit.title, date: fromDbDate(visit.date) },
        link: '/attendance',
        dedupeKey: `attendance.absent:${visitId}`,
      });
      return { absences: created.length, notified };
    });
  }
}
