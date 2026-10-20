import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type CommitImportRequest,
  groupNameKey,
  IMPORT_MAX_FILE_BYTES,
  type ImportPreview,
  type ImportResult,
  type ImportRow,
  type ImportStatus,
  type ImportSummary,
  type ImportSummaryItem,
  type ListImportsResponse,
} from '@ftms/core';
import { type AuditEvent, AuditService } from '../../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../../auth/principal';
import { Errors } from '../../common/api-exception';
import { dbViolation } from '../../common/db-errors';
import { type RequestContext } from '../../common/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { Prisma, type StudentImport } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_BUCKETS } from '../../storage/buckets';
import { StorageService } from '../../storage/storage.service';
import { GroupsService } from '../groups.service';
import { StudentErrors } from '../student-errors';
import { studentSnapshot } from '../student-mapping';
import { parseStudentWorkbook } from './import-parser';
import {
  type ExistingStudent,
  type ImportPlan,
  type NormalizedRow,
  normalizeRow,
  type PlanContext,
  planImport,
} from './import-plan';

/** Previews stay committable this long; then the file must be uploaded again. */
const PREVIEW_HOURS = 24;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface StoredResult extends ImportResult {
  rows: ImportRow[];
}

export interface UploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/**
 * Spreadsheet import of student records (§4.1): validate → preview → explicit
 * commit. The plan is recomputed against live data for every preview and again
 * inside the commit transaction; a commit whose plan no longer matches what the
 * user confirmed is refused (IMPORT_PREVIEW_STALE), so nothing the user did not
 * see is ever written.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly groups: GroupsService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  private statusOf(
    record: Pick<StudentImport, 'status' | 'expiresAt'>,
    now = new Date(),
  ): ImportStatus {
    if (record.status === 'PREVIEW' && record.expiresAt <= now) return 'EXPIRED';
    return record.status;
  }

  /** Loads the database facts the plan depends on (only for values in the file). */
  private async planContext(
    client: Prisma.TransactionClient | PrismaService,
    rows: readonly NormalizedRow[],
    canAssignGroups: boolean,
  ): Promise<PlanContext> {
    const seats = [...new Set(rows.map((r) => r.seatNumber).filter((s): s is string => !!s))];
    const emails = [...new Set(rows.map((r) => r.universityEmail).filter((e): e is string => !!e))];

    const students = seats.length
      ? await client.studentProfile.findMany({
          where: { seatNumber: { in: seats } },
          include: { memberships: { where: { endedAt: null }, include: { group: true } } },
        })
      : [];
    const bySeat = new Map<string, ExistingStudent>(
      students.map((s) => [
        s.seatNumber,
        {
          id: s.id,
          userId: s.userId,
          seatNumber: s.seatNumber,
          fullName: s.fullName,
          firstName: s.firstName,
          fatherName: s.fatherName,
          grandfatherName: s.grandfatherName,
          familyName: s.familyName,
          universityEmail: s.universityEmail,
          phone: s.phone,
          group: s.memberships[0]
            ? { id: s.memberships[0].group.id, name: s.memberships[0].group.name }
            : null,
        },
      ]),
    );

    const emailOwners = new Map<string, { studentId: string | null; staff: boolean }>();
    if (emails.length) {
      const owners = await client.studentProfile.findMany({
        where: { universityEmail: { in: emails } },
        select: { id: true, universityEmail: true },
      });
      for (const o of owners)
        emailOwners.set(o.universityEmail!, { studentId: o.id, staff: false });
      const staff = await client.user.findMany({
        where: { email: { in: emails }, role: { not: 'STUDENT' } },
        select: { email: true },
      });
      for (const u of staff) emailOwners.set(u.email, { studentId: null, staff: true });
    }

    const allGroups = await client.trainingGroup.findMany({
      select: { id: true, name: true, archivedAt: true },
    });
    const groups = new Map(
      allGroups.map((g) => [
        groupNameKey(g.name),
        { id: g.id, name: g.name, archived: g.archivedAt !== null },
      ]),
    );
    return { bySeat, emailOwners, groups, canAssignGroups };
  }

  private rowsOf(record: StudentImport): NormalizedRow[] {
    return record.rows as unknown as NormalizedRow[];
  }

  private summaryItem(record: StudentImport): ImportSummaryItem {
    const result = record.result as unknown as StoredResult | null;
    return {
      id: record.id,
      status: this.statusOf(record),
      fileName: record.fileName,
      createdAt: record.createdAt.toISOString(),
      createdBy: { name: record.createdByName },
      summary: record.summary as unknown as ImportSummary,
      result: result
        ? {
            created: result.created,
            updated: result.updated,
            skippedUpdates: result.skippedUpdates,
            skippedInvalid: result.skippedInvalid,
            unchanged: result.unchanged,
          }
        : null,
      committedAt: record.committedAt?.toISOString() ?? null,
    };
  }

  private toPreview(
    record: StudentImport,
    principal: AuthPrincipal,
    plan: Pick<ImportPlan, 'rows' | 'summary' | 'digest'> | null,
  ): ImportPreview {
    const stored = record.result as unknown as StoredResult | null;
    const item = this.summaryItem(record);
    return {
      ...item,
      summary: plan?.summary ?? item.summary,
      expiresAt: record.expiresAt.toISOString(),
      ignoredColumns: record.ignoredColumns as unknown as string[],
      planDigest: plan?.digest ?? '',
      rows: plan?.rows ?? stored?.rows ?? [],
      ownedByMe: record.createdById === principal.userId,
    };
  }

  /* ───────────────────────────── upload + preview ───────────────────────────── */

  async upload(
    principal: AuthPrincipal,
    file: UploadedFile | undefined,
    context: RequestContext,
  ): Promise<ImportPreview> {
    if (!file || file.size === 0) throw StudentErrors.fileInvalid('no file was uploaded');
    if (file.size > IMPORT_MAX_FILE_BYTES) throw StudentErrors.fileTooLarge();
    if (!/\.xlsx$/i.test(file.originalname))
      throw StudentErrors.fileInvalid('only .xlsx files are accepted');

    const parsed = await parseStudentWorkbook(file.buffer);
    const domains = this.config.get('UNIVERSITY_EMAIL_DOMAINS');
    const rows = parsed.rows.map((raw) => normalizeRow(raw, domains));
    const canAssignGroups = principal.permissions.has('groups.manage');
    const plan = planImport(rows, await this.planContext(this.prisma, rows, canAssignGroups));

    const now = new Date();
    const fileName = file.originalname.normalize('NFC').slice(-255);
    const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const record = await this.prisma.studentImport.create({
      data: {
        fileName,
        fileSize: file.size,
        fileSha256,
        rows: rows as unknown as Prisma.InputJsonValue,
        ignoredColumns: parsed.ignoredColumns,
        summary: plan.summary,
        createdById: principal.userId,
        createdByName: principal.displayName,
        expiresAt: new Date(now.getTime() + PREVIEW_HOURS * 3600_000),
      },
    });

    // Keep the original file for the audit trail (§16.3: private bucket).
    let storagePath: string | null = null;
    if (this.storage.isConfigured) {
      storagePath = `${now.getUTCFullYear()}/${record.id}.xlsx`;
      try {
        await this.storage.upload(
          STORAGE_BUCKETS.studentImports.id,
          storagePath,
          file.buffer,
          XLSX_TYPE,
        );
        await this.prisma.studentImport.update({ where: { id: record.id }, data: { storagePath } });
      } catch (error) {
        await this.prisma.studentImport.update({
          where: { id: record.id },
          data: { status: 'DISCARDED', discardedAt: new Date() },
        });
        this.logger.error(`Storing import ${record.id} failed: ${String(error)}`);
        throw error;
      }
    }

    await this.audit.record({
      actor: actorOf(principal),
      action: 'student_import.previewed',
      resourceType: 'student_import',
      resourceId: record.id,
      outcome: 'SUCCESS',
      after: { ...plan.summary },
      metadata: {
        fileName,
        fileSize: file.size,
        fileSha256,
        sheet: parsed.sheetName,
        columns: parsed.columns,
        ignoredColumns: parsed.ignoredColumns,
        storedFile: storagePath !== null,
      },
      context,
    });

    const fresh = await this.prisma.studentImport.findUniqueOrThrow({ where: { id: record.id } });
    return this.toPreview(fresh, principal, plan);
  }

  async list(): Promise<ListImportsResponse> {
    const records = await this.prisma.studentImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: records.map((r) => this.summaryItem(r)) };
  }

  private async load(id: string): Promise<StudentImport> {
    const record = await this.prisma.studentImport.findUnique({ where: { id } });
    if (!record) throw Errors.notFound('Import');
    return record;
  }

  /** An open preview is re-planned against live data; a finished import shows what it did. */
  async preview(principal: AuthPrincipal, id: string): Promise<ImportPreview> {
    const record = await this.load(id);
    if (this.statusOf(record) !== 'PREVIEW') return this.toPreview(record, principal, null);
    const rows = this.rowsOf(record);
    const plan = planImport(
      rows,
      await this.planContext(this.prisma, rows, principal.permissions.has('groups.manage')),
    );
    return this.toPreview(record, principal, plan);
  }

  async discard(principal: AuthPrincipal, id: string, context: RequestContext): Promise<void> {
    const record = await this.load(id);
    if (record.createdById !== principal.userId) throw StudentErrors.importNotOwner();
    const changed = await this.prisma.studentImport.updateMany({
      where: { id, status: 'PREVIEW' },
      data: { status: 'DISCARDED', discardedAt: new Date() },
    });
    if (changed.count !== 1) throw StudentErrors.importNotOpen();
    await this.audit.record({
      actor: actorOf(principal),
      action: 'student_import.discarded',
      resourceType: 'student_import',
      resourceId: id,
      outcome: 'SUCCESS',
      metadata: { fileName: record.fileName },
      context,
    });
  }

  /* ─────────────────────────────── commit ─────────────────────────────── */

  async commit(
    principal: AuthPrincipal,
    id: string,
    input: CommitImportRequest,
    context: RequestContext,
  ): Promise<ImportPreview> {
    const record = await this.load(id);
    if (record.createdById !== principal.userId) throw StudentErrors.importNotOwner();
    if (this.statusOf(record) !== 'PREVIEW') throw StudentErrors.importNotOpen();
    const rows = this.rowsOf(record);
    const actor = actorOf(principal);

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // Claim the import first: a second, parallel commit stops here.
          const claimed = await tx.studentImport.updateMany({
            where: { id, status: 'PREVIEW', expiresAt: { gt: new Date() } },
            data: { status: 'COMMITTED', committedAt: new Date(), committedById: principal.userId },
          });
          if (claimed.count !== 1) throw StudentErrors.importNotOpen();

          const plan = planImport(
            rows,
            await this.planContext(tx, rows, principal.permissions.has('groups.manage')),
          );
          if (plan.digest !== input.planDigest) throw StudentErrors.importStale();
          if (plan.summary.error > 0 && !input.skipInvalidRows)
            throw StudentErrors.importHasErrors();

          const creates = plan.writes.filter((w) => w.action === 'CREATE');
          const updates = input.applyUpdates
            ? plan.writes.filter((w) => w.action === 'UPDATE')
            : [];
          const meta = (rowNumber: number) => ({ source: 'import', importId: id, rowNumber });

          // New records, in bulk.
          const created = creates.length
            ? await tx.studentProfile.createManyAndReturn({
                data: creates.map((w) => ({
                  seatNumber: w.seatNumber,
                  fullName: w.data.fullName!,
                  firstName: w.data.firstName ?? null,
                  fatherName: w.data.fatherName ?? null,
                  grandfatherName: w.data.grandfatherName ?? null,
                  familyName: w.data.familyName ?? null,
                  universityEmail: w.data.universityEmail ?? null,
                  phone: w.data.phone ?? null,
                  createdById: principal.userId,
                })),
              })
            : [];
          const idBySeat = new Map(created.map((s) => [s.seatNumber, s]));
          const events: AuditEvent[] = [];
          const memberships: Prisma.GroupMembershipCreateManyInput[] = [];
          const groupNames = new Map(
            (await tx.trainingGroup.findMany({ select: { id: true, name: true } })).map((g) => [
              g.id,
              g.name,
            ]),
          );
          for (const w of creates) {
            const student = idBySeat.get(w.seatNumber)!;
            events.push({
              actor,
              action: 'student.created',
              resourceType: 'student',
              resourceId: student.id,
              outcome: 'SUCCESS',
              after: studentSnapshot(student),
              metadata: meta(w.rowNumber),
              context,
            });
            if (w.groupId) {
              memberships.push({
                studentId: student.id,
                groupId: w.groupId,
                source: 'IMPORT',
                assignedById: principal.userId,
              });
              events.push({
                actor,
                action: 'group.member_added',
                resourceType: 'student',
                resourceId: student.id,
                outcome: 'SUCCESS',
                before: { group: null },
                after: { group: { id: w.groupId, name: groupNames.get(w.groupId) ?? null } },
                metadata: { ...meta(w.rowNumber), source: 'IMPORT' },
                context,
              });
            }
          }
          if (memberships.length) await tx.groupMembership.createMany({ data: memberships });

          // Confirmed updates, one by one (each with its before/after).
          for (const w of updates) {
            const before = await tx.studentProfile.findUniqueOrThrow({
              where: { id: w.studentId! },
            });
            if (Object.keys(w.data).length > 0) {
              const after = await tx.studentProfile.update({
                where: { id: before.id },
                data: w.data,
              });
              if (before.userId && after.fullName !== before.fullName) {
                await tx.user.update({
                  where: { id: before.userId },
                  data: { displayName: after.fullName },
                });
              }
              events.push({
                actor,
                action: 'student.updated',
                resourceType: 'student',
                resourceId: before.id,
                outcome: 'SUCCESS',
                before: studentSnapshot(before),
                after: studentSnapshot(after),
                metadata: meta(w.rowNumber),
                context,
              });
            }
            if (w.groupId) {
              await this.groups.moveInTx(tx, {
                studentId: before.id,
                groupId: w.groupId,
                source: 'IMPORT',
                actor,
                context,
                metadata: { importId: id, rowNumber: w.rowNumber },
              });
            }
          }
          await this.audit.recordMany(events, tx);

          const result: StoredResult = {
            created: creates.length,
            updated: updates.length,
            skippedUpdates: input.applyUpdates ? 0 : plan.summary.update,
            skippedInvalid: plan.summary.error,
            unchanged: plan.summary.unchanged,
            rows: plan.rows,
          };
          await tx.studentImport.update({
            where: { id },
            data: {
              summary: plan.summary,
              result: result as unknown as Prisma.InputJsonValue,
            },
          });
          await this.audit.record(
            {
              actor,
              action: 'student_import.committed',
              resourceType: 'student_import',
              resourceId: id,
              outcome: 'SUCCESS',
              after: {
                created: result.created,
                updated: result.updated,
                skippedUpdates: result.skippedUpdates,
                skippedInvalid: result.skippedInvalid,
                unchanged: result.unchanged,
              },
              metadata: {
                fileName: record.fileName,
                fileSha256: record.fileSha256,
                applyUpdates: input.applyUpdates,
                skipInvalidRows: input.skipInvalidRows,
              },
              context,
            },
            tx,
          );
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (error) {
      // A concurrent change slipped in between planning and writing.
      const violation = dbViolation(error);
      if (violation) throw StudentErrors.importStale();
      throw error;
    }
    return this.preview(principal, id);
  }
}
