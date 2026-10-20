import { Injectable } from '@nestjs/common';
import {
  type CreateProgramRequest,
  type LocalDate,
  type Program,
  PROGRAM_TIME_ZONE,
  programEndDate,
  type ProgramState,
  type SettingsChange,
  type UpdateProgramRequest,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { isUniqueViolation } from '../common/db-errors';
import { type RequestContext } from '../common/request-context';
import { type Prisma, type TrainingProgram } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromDbDate, timingOf, toDbDate } from './db-values';
import { SchedulingErrors } from './scheduling-errors';

type Db = Prisma.TransactionClient | PrismaService;

export const toProgram = (p: TrainingProgram): Program => {
  const startDate = fromDbDate(p.startDate);
  return {
    id: p.id,
    name: p.name,
    startDate,
    endDate: programEndDate(startDate, p.durationWeeks),
    durationWeeks: p.durationWeeks,
    timeZone: p.timeZone,
    timing: timingOf(p),
    allowedAbsences: p.allowedAbsences,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
};

/** The values audited for configuration history (§11.3). */
const snapshot = (p: TrainingProgram) => {
  const program = toProgram(p);
  return {
    name: program.name,
    startDate: program.startDate,
    durationWeeks: program.durationWeeks,
    allowedAbsences: program.allowedAbsences,
    timing: program.timing,
  };
};

const SCHEDULE_FIELDS = ['name', 'startDate', 'durationWeeks'] as const;
const ATTENDANCE_FIELDS = ['allowedAbsences', 'timing'] as const;

/**
 * Training program settings (§6.1, §8.1, §11). Schedule fields need
 * `schedule.manage`; attendance defaults need `attendance.settings.defaults`.
 * Changed defaults apply to visits created afterwards only (§8.1).
 */
@Injectable()
export class ProgramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  current(db: Db = this.prisma): Promise<TrainingProgram | null> {
    return db.trainingProgram.findFirst({ where: { isCurrent: true } });
  }

  async requireCurrent(db: Db = this.prisma): Promise<TrainingProgram> {
    const program = await this.current(db);
    if (!program) throw SchedulingErrors.programNotConfigured();
    return program;
  }

  /** Throws DATE_OUTSIDE_PROGRAM unless `date` falls within the program. */
  static assertWithin(program: TrainingProgram, date: LocalDate, field: string): void {
    const { startDate, endDate } = toProgram(program);
    if (date < startDate || date > endDate) throw SchedulingErrors.outsideProgram(field);
  }

  async get(): Promise<ProgramState> {
    const program = await this.current();
    return { program: program ? toProgram(program) : null };
  }

  async create(
    principal: AuthPrincipal,
    input: CreateProgramRequest,
    context: RequestContext,
  ): Promise<Program> {
    try {
      const program = await this.prisma.$transaction(async (tx) => {
        if (await this.current(tx)) throw SchedulingErrors.programExists();
        const created = await tx.trainingProgram.create({
          data: {
            name: input.name,
            startDate: toDbDate(input.startDate),
            durationWeeks: input.durationWeeks,
            timeZone: PROGRAM_TIME_ZONE,
            allowedAbsences: input.allowedAbsences,
            ...input.timing,
            createdById: principal.userId,
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'program.created',
            resourceType: 'program',
            resourceId: created.id,
            outcome: 'SUCCESS',
            after: snapshot(created),
            context,
          },
          tx,
        );
        return created;
      });
      return toProgram(program);
    } catch (error) {
      if (isUniqueViolation(error, 'training_programs_one_current')) {
        throw SchedulingErrors.programExists();
      }
      throw error;
    }
  }

  async update(
    principal: AuthPrincipal,
    input: UpdateProgramRequest,
    context: RequestContext,
  ): Promise<Program> {
    const touches = (fields: readonly (keyof UpdateProgramRequest)[]) =>
      fields.some((f) => input[f] !== undefined);
    if (touches(SCHEDULE_FIELDS) && !principal.permissions.has('schedule.manage')) {
      throw Errors.forbidden();
    }
    if (touches(ATTENDANCE_FIELDS) && !principal.permissions.has('attendance.settings.defaults')) {
      throw Errors.forbidden();
    }

    const program = await this.prisma.$transaction(async (tx) => {
      const current = await this.requireCurrent(tx);
      await tx.$queryRaw`SELECT 1 FROM "training_programs" WHERE "id" = ${current.id}::uuid FOR UPDATE`;
      const data: Prisma.TrainingProgramUpdateInput = {
        name: input.name,
        startDate: input.startDate === undefined ? undefined : toDbDate(input.startDate),
        durationWeeks: input.durationWeeks,
        allowedAbsences: input.allowedAbsences,
        ...(input.timing ?? {}),
      };
      const updated = await tx.trainingProgram.update({ where: { id: current.id }, data });

      const before = snapshot(current);
      const after = snapshot(updated);
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      if (changed.length > 0) {
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'program.updated',
            resourceType: 'program',
            resourceId: current.id,
            outcome: 'SUCCESS',
            reason: input.reason ?? null,
            before: Object.fromEntries(changed.map((k) => [k, before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, after[k]])),
            context,
          },
          tx,
        );
      }
      return updated;
    });
    return toProgram(program);
  }

  /** Who changed which setting, when, from what to what (§11.3). */
  async history(): Promise<SettingsChange[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { resourceType: 'program', outcome: 'SUCCESS' },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      at: row.occurredAt.toISOString(),
      actorName: row.actorName,
      action: row.action,
      reason: row.reason,
      before: (row.before ?? null) as Record<string, unknown> | null,
      after: (row.after ?? null) as Record<string, unknown> | null,
    }));
  }
}
