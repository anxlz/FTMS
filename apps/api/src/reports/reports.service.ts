import { Injectable } from '@nestjs/common';
import {
  ATTENDANCE_SUMMARY_MAX_ROWS,
  attendanceTotals,
  AUDIT_CATEGORIES,
  type AttendanceStanding,
  type AttendanceSummaryQuery,
  type AttendanceSummaryResponse,
  type AttendanceSummaryRow,
  nameMatchKey,
  type ReportExportQuery,
} from '@ftms/core';
import { AbsencesService } from '../attendance/absences.service';
import { AttendanceErrors } from '../attendance/attendance-errors';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import { renderTablePdf } from '../common/table-pdf';
import {
  cairoText,
  type Cell,
  CONTENT_TYPES,
  type ExportFile,
  fileStamp,
  toCsv,
  toXlsx,
} from '../common/tabular-export';
import { PrismaService } from '../prisma/prisma.service';
import { REPORT_LABELS } from './report-labels';

/** Standing against the allowance: over it, exactly used up, or within. */
export function standingOf(absent: number, allowed: number | null): AttendanceStanding {
  if (allowed === null) return 'within';
  if (absent > allowed) return 'over';
  if (absent === allowed && absent > 0) return 'atLimit';
  return 'within';
}

/**
 * Training-wide reports (§3.2, §10.1, §19): the attendance standing of every
 * student, and the faculty activity summary. Figures come from the same
 * records and rules as the dashboards (finalized records of visits that were
 * not cancelled; `remaining = max(0, allowed − absent)`), and every file
 * produced is recorded in the audit log.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logs: AuditLogService,
    private readonly absences: AbsencesService,
    private readonly clock: Clock,
  ) {}

  async attendanceSummary(query: AttendanceSummaryQuery): Promise<AttendanceSummaryResponse> {
    const program = await this.prisma.trainingProgram.findFirst({ where: { isCurrent: true } });
    // Absences of visits whose window has closed count at once, even if the job lags.
    if (program) await this.absences.processDue(200, { programId: program.id });

    const students = await this.prisma.studentProfile.findMany({
      where:
        query.group === 'none'
          ? { memberships: { none: { endedAt: null } } }
          : query.group
            ? { memberships: { some: { endedAt: null, groupId: query.group } } }
            : {},
      select: {
        id: true,
        fullName: true,
        seatNumber: true,
        memberships: {
          where: { endedAt: null },
          select: { group: { select: { id: true, name: true } } },
        },
      },
    });
    const needle = query.q ? nameMatchKey(query.q) : '';
    const matching = query.q
      ? students.filter(
          (s) =>
            s.seatNumber.toLowerCase().includes(query.q!.toLowerCase()) ||
            (needle !== '' && nameMatchKey(s.fullName).includes(needle)),
        )
      : students;
    if (matching.length > ATTENDANCE_SUMMARY_MAX_ROWS) {
      throw AttendanceErrors.exportTooLarge(ATTENDANCE_SUMMARY_MAX_ROWS);
    }

    const records = program
      ? await this.prisma.attendanceRecord.findMany({
          where: {
            studentId: { in: matching.map((s) => s.id) },
            visit: { programId: program.id, status: 'SCHEDULED' },
          },
          select: { studentId: true, status: true, minutesLate: true },
        })
      : [];
    const byStudent = new Map<string, typeof records>();
    for (const r of records) {
      const list = byStudent.get(r.studentId) ?? [];
      list.push(r);
      byStudent.set(r.studentId, list);
    }

    const allowed = program?.allowedAbsences ?? null;
    const rows: AttendanceSummaryRow[] = matching
      .map((s) => {
        const own = byStudent.get(s.id) ?? [];
        const totals = attendanceTotals(
          own.map((r) => r.status),
          allowed ?? 0,
        );
        return {
          studentId: s.id,
          fullName: s.fullName,
          seatNumber: s.seatNumber,
          group: s.memberships[0]?.group ?? null,
          recorded: own.length,
          present: totals.present,
          late: totals.late,
          absent: totals.absent,
          lateMinutes: own.reduce((n, r) => n + (r.status === 'LATE' ? r.minutesLate : 0), 0),
          remainingAbsences: totals.remainingAbsences,
          standing: standingOf(totals.absent, allowed),
        };
      })
      .filter((r) => !query.standing || r.standing === query.standing)
      .sort(
        (a, b) =>
          (a.group?.name ?? '￿').localeCompare(b.group?.name ?? '￿', 'ar') ||
          a.fullName.localeCompare(b.fullName, 'ar'),
      );

    return {
      allowedAbsences: allowed,
      rows,
      totals: {
        students: rows.length,
        present: rows.reduce((n, r) => n + r.present, 0),
        late: rows.reduce((n, r) => n + r.late, 0),
        absent: rows.reduce((n, r) => n + r.absent, 0),
        over: rows.filter((r) => r.standing === 'over').length,
        atLimit: rows.filter((r) => r.standing === 'atLimit').length,
      },
    };
  }

  private async recordExport(
    principal: AuthPrincipal,
    report: 'attendance_summary' | 'faculty_activity',
    query: ReportExportQuery,
    rows: number,
    context: RequestContext,
  ): Promise<void> {
    await this.audit.record({
      actor: actorOf(principal),
      action: 'report.exported',
      resourceType: 'report',
      resourceId: report,
      outcome: 'SUCCESS',
      metadata: {
        report,
        format: query.format,
        rows,
        filters: {
          group: query.group ?? null,
          q: query.q ?? null,
          standing: query.standing ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
        },
      },
      context,
    });
  }

  async exportAttendanceSummary(
    principal: AuthPrincipal,
    query: ReportExportQuery,
    context: RequestContext,
  ): Promise<ExportFile> {
    const summary = await this.attendanceSummary(query);
    const labels = REPORT_LABELS[query.locale];
    const s = labels.summary;
    const c = s.columns;
    const header = [
      c.student,
      c.seat,
      c.group,
      c.recorded,
      c.present,
      c.late,
      c.absent,
      c.lateMinutes,
      c.remaining,
      c.standing,
    ];
    const lines: Cell[][] = summary.rows.map((r) => [
      r.fullName,
      r.seatNumber,
      r.group?.name ?? s.noGroup,
      r.recorded,
      r.present,
      r.late,
      r.absent,
      r.lateMinutes,
      r.remainingAbsences,
      s.standings[r.standing],
    ]);
    const now = this.clock.now();
    const filters = [
      query.group ? `group=${query.group}` : null,
      query.q ? `q=${query.q}` : null,
      query.standing ? `${c.standing}=${s.standings[query.standing]}` : null,
    ].filter(Boolean);
    let body: Buffer;
    if (query.format === 'pdf') {
      body = await renderTablePdf({
        title: s.title,
        meta: [
          `${labels.generated}: ${cairoText(now)}`,
          `${labels.filters}: ${filters.length > 0 ? filters.join(' · ') : labels.allRecords}`,
          `${s.allowed}: ${summary.allowedAbsences ?? '—'} · ${labels.rows}: ${lines.length}`,
        ],
        columns: [22, 10, 14, 8, 7, 7, 7, 8, 8, 9].map((width, i) => ({
          label: header[i]!,
          width,
        })),
        rows: lines.map((line) => line.map(String)),
        rtl: query.locale === 'ar',
        pageLabel: labels.page,
      });
    } else if (query.format === 'xlsx') {
      body = await toXlsx([header, ...lines], {
        sheet: s.sheet,
        rtl: query.locale === 'ar',
        widths: [30, 13, 18, 10, 9, 9, 9, 11, 11, 16],
        created: now,
      });
    } else {
      body = toCsv([header, ...lines]);
    }
    await this.recordExport(principal, 'attendance_summary', query, lines.length, context);
    return {
      body,
      contentType: CONTENT_TYPES[query.format],
      fileName: `ftms-attendance-summary-${fileStamp(now)}.${query.format}`,
    };
  }

  async exportFacultyActivity(
    principal: AuthPrincipal,
    query: ReportExportQuery,
    context: RequestContext,
  ): Promise<ExportFile> {
    const activity = await this.logs.activity({ from: query.from, to: query.to });
    const labels = REPORT_LABELS[query.locale];
    const a = labels.activity;
    const c = a.columns;
    const status = (row: (typeof activity.rows)[number]) =>
      row.actor.status ? a.statuses[row.actor.status] : a.removed;
    const last = (iso: string | null) => (iso ? cairoText(new Date(iso)) : '—');
    const now = this.clock.now();
    const meta = [
      `${labels.generated}: ${cairoText(now)}`,
      `${a.period}: ${activity.from} – ${activity.to}`,
    ];
    let body: Buffer;
    if (query.format === 'pdf') {
      const header = [
        c.staff,
        c.role,
        c.status,
        c.total,
        c.decisions,
        c.failures,
        labels.audit.columns.category,
        c.lastAction,
      ];
      body = await renderTablePdf({
        title: a.title,
        meta: [...meta, `${labels.rows}: ${activity.rows.length}`],
        columns: [18, 12, 9, 7, 7, 7, 27, 13].map((width, i) => ({ label: header[i]!, width })),
        rows: activity.rows.map((r) => [
          r.actor.name,
          labels.roles[r.actor.role],
          status(r),
          String(r.total),
          String(r.decisions),
          String(r.failures),
          AUDIT_CATEGORIES.filter((k) => r.categories[k])
            .map((k) => `${labels.categories[k]} ${r.categories[k]}`)
            .join(' · '),
          last(r.lastActionAt),
        ]),
        rtl: query.locale === 'ar',
        pageLabel: labels.page,
      });
    } else {
      const header: Cell[] = [
        c.staff,
        c.role,
        c.status,
        c.total,
        c.decisions,
        c.failures,
        ...AUDIT_CATEGORIES.map((k) => labels.categories[k]),
        c.lastAction,
      ];
      const lines: Cell[][] = activity.rows.map((r) => [
        r.actor.name,
        labels.roles[r.actor.role],
        status(r),
        r.total,
        r.decisions,
        r.failures,
        ...AUDIT_CATEGORIES.map((k) => r.categories[k] ?? 0),
        last(r.lastActionAt),
      ]);
      body =
        query.format === 'xlsx'
          ? await toXlsx([header, ...lines], {
              sheet: a.sheet,
              rtl: query.locale === 'ar',
              widths: [26, 18, 14, 9, 9, 9, ...AUDIT_CATEGORIES.map(() => 12), 17],
              created: now,
            })
          : toCsv([header, ...lines]);
    }
    await this.recordExport(principal, 'faculty_activity', query, activity.rows.length, context);
    return {
      body,
      contentType: CONTENT_TYPES[query.format],
      fileName: `ftms-faculty-activity-${fileStamp(now)}.${query.format}`,
    };
  }
}
