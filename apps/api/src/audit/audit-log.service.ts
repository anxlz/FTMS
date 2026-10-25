import { Injectable } from '@nestjs/common';
import {
  actionsInCategory,
  addDays,
  AUDIT_EXPORT_MAX_ROWS,
  auditCategoryOf,
  auditChanges,
  type AuditCategory,
  type AuditEntry,
  type AuditEntryDetail,
  type AuditExportQuery,
  type AuditFacetsResponse,
  type AuditResource,
  type AuditResourceType,
  DECISION_ACTIONS,
  FACULTY_ACTIVITY_DEFAULT_DAYS,
  type FacultyActivityQuery,
  type FacultyActivityResponse,
  type FacultyActivityRow,
  isAuditAction,
  type ListAuditLogsQuery,
  type ListAuditLogsResponse,
  PROGRAM_TIME_ZONE,
  STAFF_ROLES,
  todayIn,
  zonedToUtc,
} from '@ftms/core';
import { AttendanceErrors } from '../attendance/attendance-errors';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { Clock } from '../common/clock';
import { type RequestContext } from '../common/request-context';
import {
  cairoText,
  type Cell,
  CONTENT_TYPES,
  type ExportFile,
  fileStamp,
  toCsv,
  toXlsx,
} from '../common/tabular-export';
import { type AuditLog, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExportThrottle } from '../rate-limit/export-throttle';
import { REPORT_LABELS, type ReportLabels } from '../reports/report-labels';
import { fromDbDate } from '../scheduling/db-values';
import { AuditService } from './audit.service';
import { literal } from '../common/search';

type Filters = Omit<ListAuditLogsQuery, 'page' | 'pageSize'>;
type Json = Record<string, unknown>;

const asJson = (value: Prisma.JsonValue | null): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Start of `date` in Cairo, and the start of the day after `date` (exclusive end). */
const dayStart = (date: string) => zonedToUtc(date, '00:00', PROGRAM_TIME_ZONE);
const dayEnd = (date: string) => zonedToUtc(addDays(date, 1), '00:00', PROGRAM_TIME_ZONE);

/** Short text for a value in exports ("—" for nothing). */
const shown = (value: unknown): string =>
  value === undefined || value === null || value === ''
    ? '—'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

/**
 * The read side of the shared audit log (§15.3): the Training Director's
 * searchable log, one event with its before/after comparison and the record
 * it concerns, the faculty activity summary and exports. Writes stay in
 * `AuditService`; nothing here can change or remove an event (§15.4).
 */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly throttle: ExportThrottle,
  ) {}

  /* ─────────────────────────── the log ─────────────────────────── */

  private where(q: Filters): Prisma.AuditLogWhereInput {
    const and: Prisma.AuditLogWhereInput[] = [];
    if (q.scope === 'staff') and.push({ actorRole: { in: [...STAFF_ROLES] } });
    if (q.scope === 'students') and.push({ actorRole: 'STUDENT' });
    if (q.scope === 'system') and.push({ actorId: null, actorRole: null });
    if (q.actor) and.push({ actorId: q.actor });
    if (q.action) and.push({ action: q.action });
    if (q.category) and.push({ action: { in: actionsInCategory(q.category) } });
    if (q.decisions) and.push({ action: { in: [...DECISION_ACTIONS] } });
    if (q.resourceType) and.push({ resourceType: q.resourceType });
    if (q.resourceId) and.push({ resourceId: q.resourceId });
    if (q.outcome) and.push({ outcome: q.outcome });
    if (q.from) and.push({ occurredAt: { gte: dayStart(q.from) } });
    if (q.to) and.push({ occurredAt: { lt: dayEnd(q.to) } });
    if (q.q) {
      and.push({
        OR: [
          { actorName: { contains: literal(q.q), mode: 'insensitive' } },
          { action: { contains: literal(q.q), mode: 'insensitive' } },
          { resourceId: q.q },
          { reason: { contains: literal(q.q), mode: 'insensitive' } },
        ],
      });
    }
    return and.length > 0 ? { AND: and } : {};
  }

  private toEntry(row: AuditLog): AuditEntry {
    // Every writer is typed against the catalogue; anything else is shown as a sign-in event
    // rather than breaking the page (it cannot happen through the application).
    const action = isAuditAction(row.action) ? row.action : 'auth.login';
    return {
      id: row.id.toString(),
      at: row.occurredAt.toISOString(),
      actor:
        row.actorId || row.actorName || row.actorRole
          ? { id: row.actorId, name: row.actorName, role: row.actorRole }
          : null,
      action,
      category: auditCategoryOf(action),
      resourceType: row.resourceType as AuditResourceType,
      resourceId: row.resourceId,
      outcome: row.outcome,
      reason: row.reason,
      before: asJson(row.before),
      after: asJson(row.after),
      metadata: asJson(row.metadata),
    };
  }

  async list(query: ListAuditLogsQuery): Promise<ListAuditLogsResponse> {
    const where = this.where(query);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map((r) => this.toEntry(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(id: string): Promise<AuditEntryDetail> {
    const row = await this.prisma.auditLog.findUnique({ where: { id: BigInt(id) } });
    if (!row) throw Errors.notFound('Audit event');
    const entry = this.toEntry(row);
    const [resource, related] = await Promise.all([
      row.resourceId ? this.resource(entry.resourceType, row.resourceId) : null,
      row.resourceId
        ? this.prisma.auditLog.findMany({
            where: {
              resourceType: row.resourceType,
              resourceId: row.resourceId,
              id: { not: row.id },
            },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: 20,
          })
        : [],
    ]);
    return {
      ...entry,
      ip: row.ip,
      userAgent: row.userAgent,
      changes: auditChanges(entry.before, entry.after),
      resource,
      related: related.map((r) => this.toEntry(r)),
    };
  }

  /**
   * The record an event concerns, as it is now (§15.3): whether it still
   * exists and how to recognize it. Deleted records keep their history.
   */
  private async resource(type: AuditResourceType, id: string): Promise<AuditResource> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const found = (label: string | null, visitId: string | null = null): AuditResource => ({
      type,
      id,
      exists: true,
      label,
      visitId,
    });
    const missing: AuditResource = { type, id, exists: false, label: null, visitId: null };
    if (!isUuid) return missing;
    const p = this.prisma;
    switch (type) {
      case 'user': {
        const u = await p.user.findUnique({ where: { id }, select: { displayName: true } });
        return u ? found(u.displayName) : missing;
      }
      case 'student': {
        const s = await p.studentProfile.findUnique({
          where: { id },
          select: { fullName: true, seatNumber: true },
        });
        return s ? found(`${s.fullName} · ${s.seatNumber}`) : missing;
      }
      case 'group': {
        const g = await p.trainingGroup.findUnique({ where: { id }, select: { name: true } });
        return g ? found(g.name) : missing;
      }
      case 'visit': {
        const v = await p.trainingVisit.findUnique({
          where: { id },
          select: { title: true, date: true },
        });
        return v ? found(`${v.title} · ${fromDbDate(v.date)}`, id) : missing;
      }
      case 'schedule': {
        const s = await p.trainingSchedule.findUnique({ where: { id }, select: { title: true } });
        return s ? found(s.title) : missing;
      }
      case 'schedule_exception': {
        const e = await p.scheduleException.findUnique({
          where: { id },
          select: { date: true, reason: true },
        });
        return e ? found(`${fromDbDate(e.date)} · ${e.reason}`) : missing;
      }
      case 'program': {
        const prog = await p.trainingProgram.findUnique({ where: { id }, select: { name: true } });
        return prog ? found(prog.name) : missing;
      }
      case 'student_import': {
        const i = await p.studentImport.findUnique({ where: { id }, select: { fileName: true } });
        return i ? found(i.fileName) : missing;
      }
      case 'profile_change_request': {
        const r = await p.profileChangeRequest.findUnique({
          where: { id },
          select: { student: { select: { fullName: true, seatNumber: true } } },
        });
        return r ? found(`${r.student.fullName} · ${r.student.seatNumber}`) : missing;
      }
      case 'student_verification_request': {
        const r = await p.studentVerificationRequest.findUnique({
          where: { id },
          select: { fullName: true, seatNumber: true },
        });
        return r ? found(`${r.fullName} · ${r.seatNumber}`) : missing;
      }
      case 'attendance': {
        const r = await p.attendanceRecord.findUnique({
          where: { id },
          select: {
            visitId: true,
            visit: { select: { title: true } },
            student: { select: { fullName: true, seatNumber: true } },
          },
        });
        return r
          ? found(`${r.student.fullName} · ${r.student.seatNumber} — ${r.visit.title}`, r.visitId)
          : missing;
      }
      case 'ticket': {
        const t = await p.supportTicket.findUnique({
          where: { id },
          select: { number: true, subject: true },
        });
        return t ? found(`#${t.number} ${t.subject}`) : missing;
      }
      case 'group_swap': {
        const r = await p.groupSwapRequest.findUnique({
          where: { id },
          select: { ticket: { select: { number: true } } },
        });
        return r ? found(`#${r.ticket.number}`) : missing;
      }
      case 'webauthn_credential': {
        const c = await p.webAuthnCredential.findUnique({ where: { id }, select: { name: true } });
        return c ? found(c.name) : missing;
      }
      case 'auth_session':
      case 'report':
      case 'audit_log':
        // Sessions expire and reports are files: the event itself is the record.
        return missing;
    }
  }

  async facets(): Promise<AuditFacetsResponse> {
    const [staff, actions, types, pastActors] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: { in: [...STAFF_ROLES] } },
        select: { id: true, displayName: true, role: true, status: true },
        orderBy: { displayName: 'asc' },
      }),
      this.prisma.auditLog.groupBy({ by: ['action'] }),
      this.prisma.auditLog.groupBy({ by: ['resourceType'] }),
      this.prisma.auditLog.groupBy({
        by: ['actorId', 'actorName', 'actorRole'],
        where: { actorRole: { in: [...STAFF_ROLES] }, actorId: { not: null } },
      }),
    ]);
    const known = new Set(staff.map((u) => u.id));
    const gone = new Map<
      string,
      { id: string; name: string; role: (typeof STAFF_ROLES)[number] }
    >();
    for (const a of pastActors) {
      if (!a.actorId || known.has(a.actorId) || !a.actorRole || a.actorRole === 'STUDENT') continue;
      gone.set(a.actorId, { id: a.actorId, name: a.actorName ?? a.actorId, role: a.actorRole });
    }
    return {
      actors: [
        ...staff.map((u) => ({ id: u.id, name: u.displayName, role: u.role, status: u.status })),
        ...[...gone.values()].map((a) => ({ ...a, status: null })),
      ],
      actions: actions
        .map((a) => a.action)
        .filter(isAuditAction)
        .sort(),
      resourceTypes: types
        .map((t) => t.resourceType as AuditResourceType)
        .sort((a, b) => a.localeCompare(b)),
    };
  }

  /* ─────────────────────────── faculty activity (§15.1) ─────────────────────────── */

  private period(query: FacultyActivityQuery): { from: string; to: string } {
    const today = todayIn(PROGRAM_TIME_ZONE, this.clock.now());
    const to = query.to ?? (query.from && query.from > today ? query.from : today);
    const from = query.from ?? addDays(to, -(FACULTY_ACTIVITY_DEFAULT_DAYS - 1));
    return { from, to };
  }

  /**
   * Every staff account (also those with no activity), with what they did in
   * the period: totals, failed attempts, decisions and actions per category.
   */
  async activity(query: FacultyActivityQuery): Promise<FacultyActivityResponse> {
    const { from, to } = this.period(query);
    const inPeriod: Prisma.AuditLogWhereInput = {
      actorRole: { in: [...STAFF_ROLES] },
      actorId: { not: null },
      occurredAt: { gte: dayStart(from), lt: dayEnd(to) },
    };
    const [staff, counts] = await Promise.all([
      this.prisma.user.findMany({
        where: { role: { in: [...STAFF_ROLES] } },
        select: { id: true, displayName: true, role: true, status: true },
      }),
      this.prisma.auditLog.groupBy({
        by: ['actorId', 'actorRole', 'action', 'outcome'],
        where: inPeriod,
        _count: { _all: true },
        _max: { occurredAt: true, actorName: true },
      }),
    ]);
    const decisions = new Set<string>(DECISION_ACTIONS);
    const rows = new Map<string, FacultyActivityRow>();
    for (const u of staff) {
      rows.set(u.id, {
        actor: { id: u.id, name: u.displayName, role: u.role, status: u.status },
        total: 0,
        failures: 0,
        decisions: 0,
        categories: {},
        lastActionAt: null,
      });
    }
    for (const c of counts) {
      if (!c.actorId || !isAuditAction(c.action)) continue;
      let row = rows.get(c.actorId);
      if (!row) {
        // A staff member who acted but whose account no longer exists.
        row = {
          actor: {
            id: c.actorId,
            name: c._max.actorName ?? c.actorId,
            role: c.actorRole ?? 'FACULTY',
            status: null,
          },
          total: 0,
          failures: 0,
          decisions: 0,
          categories: {},
          lastActionAt: null,
        };
        rows.set(c.actorId, row);
      }
      const n = c._count._all;
      row.total += n;
      if (c.outcome === 'FAILURE') row.failures += n;
      else if (decisions.has(c.action)) row.decisions += n;
      const category: AuditCategory = auditCategoryOf(c.action);
      row.categories[category] = (row.categories[category] ?? 0) + n;
      const last = c._max.occurredAt?.toISOString() ?? null;
      if (last && (!row.lastActionAt || last > row.lastActionAt)) row.lastActionAt = last;
    }
    const list = [...rows.values()].sort(
      (a, b) => b.total - a.total || a.actor.name.localeCompare(b.actor.name, 'ar'),
    );
    return {
      from,
      to,
      rows: list,
      totals: {
        actions: list.reduce((n, r) => n + r.total, 0),
        failures: list.reduce((n, r) => n + r.failures, 0),
        decisions: list.reduce((n, r) => n + r.decisions, 0),
        activeStaff: list.filter((r) => r.total > 0).length,
      },
    };
  }

  /* ─────────────────────────── exports ─────────────────────────── */

  private filterText(query: Filters, labels: ReportLabels): string {
    const parts = Object.entries({
      q: query.q,
      actor: query.actor,
      scope: query.scope === 'all' ? undefined : query.scope,
      category: query.category ? labels.categories[query.category] : undefined,
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      outcome: query.outcome ? labels.outcomes[query.outcome] : undefined,
      decisions: query.decisions ? 'true' : undefined,
      from: query.from,
      to: query.to,
    }).filter(([, v]) => v !== undefined);
    return parts.length > 0 ? parts.map(([k, v]) => `${k}=${v}`).join(' · ') : labels.allRecords;
  }

  /** The filtered log as CSV or XLSX (§15.3), itself recorded in the log. */
  async export(
    principal: AuthPrincipal,
    query: AuditExportQuery,
    context: RequestContext,
  ): Promise<ExportFile> {
    await this.throttle.check(principal.userId);
    const where = this.where(query);
    const total = await this.prisma.auditLog.count({ where });
    if (total > AUDIT_EXPORT_MAX_ROWS) throw AttendanceErrors.exportTooLarge(AUDIT_EXPORT_MAX_ROWS);
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    const labels = REPORT_LABELS[query.locale];
    const c = labels.audit.columns;
    const table: Cell[][] = [
      [
        c.time,
        c.actor,
        c.role,
        c.action,
        c.category,
        c.resourceType,
        c.resourceId,
        c.outcome,
        c.reason,
        c.changes,
        c.ip,
      ],
      ...rows.map((row) => {
        const e = this.toEntry(row);
        const changes = auditChanges(e.before, e.after)
          .filter((x) => x.changed)
          .map((x) => `${x.field}: ${shown(x.before)} → ${shown(x.after)}`)
          .join('; ');
        return [
          cairoText(row.occurredAt),
          e.actor?.name ?? labels.system,
          e.actor?.role ? labels.roles[e.actor.role] : '',
          e.action,
          labels.categories[e.category],
          e.resourceType,
          e.resourceId ?? '',
          labels.outcomes[e.outcome],
          e.reason ?? '',
          changes,
          row.ip ?? '',
        ];
      }),
    ];
    const now = this.clock.now();
    const body =
      query.format === 'csv'
        ? toCsv(table)
        : await toXlsx(table, {
            sheet: labels.audit.sheet,
            rtl: query.locale === 'ar',
            widths: [17, 24, 16, 30, 22, 20, 38, 10, 30, 60, 16],
            created: now,
          });
    await this.audit.record({
      actor: actorOf(principal),
      action: 'audit.exported',
      resourceType: 'audit_log',
      outcome: 'SUCCESS',
      metadata: {
        format: query.format,
        rows: rows.length,
        filters: this.filterText(query, labels),
      },
      context,
    });
    return {
      body,
      contentType: CONTENT_TYPES[query.format],
      fileName: `ftms-audit-${fileStamp(now)}.${query.format}`,
    };
  }
}
