import { Injectable } from '@nestjs/common';
import {
  type AttendanceExportRow,
  EXPORT_MAX_ROWS,
  type ExportFormat,
  type ExportQuery,
  PROGRAM_TIME_ZONE,
  utcToZoned,
} from '@ftms/core';
import { Workbook } from 'exceljs';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import { type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fromDbDate, fromDbTime, toDbDate } from '../scheduling/db-values';
import { AbsencesService } from './absences.service';
import { AttendanceErrors } from './attendance-errors';
import { EXPORT_LABELS, type ExportLabels } from './export-labels';
import { renderAttendancePdf } from './export-pdf';

export interface ExportFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const cairo = (instant: Date): string => {
  const z = utcToZoned(instant, PROGRAM_TIME_ZONE);
  return `${z.date} ${z.time}`;
};

/** A spreadsheet must never execute a cell: text starting like a formula is neutralized. */
export const neutralizeFormula = (value: string): string =>
  /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

const csvField = (value: string | number): string => {
  if (typeof value === 'number') return String(value);
  const safe = neutralizeFormula(value);
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Attendance exports (§10.4, §19). One query feeds CSV, XLSX and PDF — and it
 * selects the same records the attendance screens show (non-cancelled visits;
 * absences finalized first) — so files match the application. The callers'
 * permissions are checked by the controller; faculty scope is training-wide.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly absences: AbsencesService,
    private readonly clock: Clock,
  ) {}

  private where(query: ExportQuery): Prisma.AttendanceRecordWhereInput {
    const visit: Prisma.TrainingVisitWhereInput = { status: 'SCHEDULED' };
    if (query.visit) visit.id = query.visit;
    if (query.from || query.to) {
      visit.date = {
        ...(query.from ? { gte: toDbDate(query.from) } : {}),
        ...(query.to ? { lte: toDbDate(query.to) } : {}),
      };
    }
    return {
      visit,
      ...(query.group ? { groupId: query.group } : {}),
      ...(query.student ? { studentId: query.student } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
  }

  async rows(query: ExportQuery): Promise<AttendanceExportRow[]> {
    // Finalize absences of visits in scope whose window has closed.
    const visitScope = (this.where(query).visit ?? {}) as Prisma.TrainingVisitWhereInput;
    await this.absences.processDue(200, visitScope);

    const where = this.where(query);
    const max = EXPORT_MAX_ROWS[query.format];
    const total = await this.prisma.attendanceRecord.count({ where });
    if (total > max) throw AttendanceErrors.exportTooLarge(max);
    const records = await this.prisma.attendanceRecord.findMany({
      where,
      include: {
        visit: {
          select: { title: true, date: true, startTime: true, endTime: true, startsAt: true },
        },
        group: { select: { name: true } },
        student: { select: { fullName: true, seatNumber: true } },
      },
    });
    return records
      .map((r): AttendanceExportRow & { sort: string } => ({
        visitTitle: r.visit.title,
        date: fromDbDate(r.visit.date),
        scheduledTime: r.visit.endTime
          ? `${fromDbTime(r.visit.startTime)}–${fromDbTime(r.visit.endTime)}`
          : fromDbTime(r.visit.startTime),
        group: r.group.name,
        studentName: r.student.fullName,
        seatNumber: r.student.seatNumber,
        status: r.status,
        checkedInAt: r.checkedInAt ? cairo(r.checkedInAt) : '',
        minutesLate: r.minutesLate,
        source: r.source,
        biometricVerified: r.biometricVerified,
        note: r.correctionReason ?? '',
        sort: `${r.visit.startsAt.toISOString()}|${r.visit.title}|${r.group.name}`,
      }))
      .sort(
        (a, b) => a.sort.localeCompare(b.sort) || a.studentName.localeCompare(b.studentName, 'ar'),
      )
      .map(({ sort: _sort, ...row }) => row);
  }

  private filterText(query: ExportQuery, labels: ExportLabels): string {
    const parts = [
      query.visit ? `visit=${query.visit}` : null,
      query.from ? `from=${query.from}` : null,
      query.to ? `to=${query.to}` : null,
      query.group ? `group=${query.group}` : null,
      query.student ? `student=${query.student}` : null,
      query.status ? `${labels.columns.status}=${labels.status[query.status]}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : labels.allRecords;
  }

  private table(rows: AttendanceExportRow[], labels: ExportLabels): (string | number)[][] {
    const c = labels.columns;
    return [
      [
        c.date,
        c.time,
        c.visit,
        c.group,
        c.student,
        c.seat,
        c.status,
        c.checkIn,
        c.minutesLate,
        c.source,
        c.biometric,
        c.note,
      ],
      ...rows.map((r) => [
        r.date,
        r.scheduledTime,
        r.visitTitle,
        r.group,
        r.studentName,
        r.seatNumber,
        labels.status[r.status],
        r.checkedInAt,
        r.minutesLate,
        labels.source[r.source],
        r.biometricVerified ? labels.yes : labels.no,
        r.note,
      ]),
    ];
  }

  async export(
    principal: AuthPrincipal,
    query: ExportQuery,
    context: RequestContext,
  ): Promise<ExportFile> {
    const rows = await this.rows(query);
    const labels = EXPORT_LABELS[query.locale];
    const now = this.clock.now();
    const stamp = cairo(now).replace(/[-: ]/g, '').slice(0, 12);
    const fileName = `ftms-attendance-${stamp}.${query.format}`;
    let body: Buffer;
    if (query.format === 'csv') {
      // UTF-8 with a byte-order mark so spreadsheet programs read Arabic correctly.
      const lines = this.table(rows, labels).map((line) => line.map(csvField).join(','));
      body = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    } else if (query.format === 'xlsx') {
      const workbook = new Workbook();
      workbook.creator = 'FTMS';
      workbook.created = now;
      const sheet = workbook.addWorksheet(labels.sheet, {
        views: [{ state: 'frozen', ySplit: 1, rightToLeft: query.locale === 'ar' }],
      });
      const table = this.table(rows, labels);
      for (const line of table) {
        sheet.addRow(line.map((v) => (typeof v === 'string' ? neutralizeFormula(v) : v)));
      }
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table[0]!.length } };
      sheet.columns.forEach((column, i) => {
        column.width = [12, 13, 28, 16, 30, 13, 10, 17, 9, 16, 10, 28][i] ?? 14;
      });
      body = Buffer.from(await workbook.xlsx.writeBuffer());
    } else {
      body = await renderAttendancePdf({
        rows,
        labels,
        rtl: query.locale === 'ar',
        generatedAt: cairo(now),
        filters: this.filterText(query, labels),
      });
    }
    await this.audit.record({
      actor: actorOf(principal),
      action: 'attendance.exported',
      resourceType: 'attendance',
      outcome: 'SUCCESS',
      metadata: {
        format: query.format,
        rows: rows.length,
        filters: {
          visit: query.visit ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
          group: query.group ?? null,
          student: query.student ?? null,
          status: query.status ?? null,
        },
      },
      context,
    });
    return { body, contentType: CONTENT_TYPES[query.format], fileName };
  }
}
