import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  VISIT_DOCUMENT_TYPES,
  VISIT_FILE_MAX_BYTES,
  type VisitDetail,
  type VisitFileKind,
  VISIT_IMAGE_TYPES,
  VISIT_MAX_DOCUMENTS,
} from '@ftms/core';
import { AuditService } from '../audit/audit.service';
import { actorOf, type AuthPrincipal } from '../auth/principal';
import { Errors } from '../common/api-exception';
import { BackgroundTasks } from '../common/background-tasks.service';
import { type RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { type BucketId, STORAGE_BUCKETS } from '../storage/buckets';
import { FileStore } from '../storage/file-store';
import { StudentErrors } from '../students/student-errors';
import { cleanFileName, sniffFileType } from './file-sniffing';
import { SchedulingErrors } from './scheduling-errors';
import { VISIT_DETAIL_INCLUDE } from './visit-mapping';
import { VisitsService } from './visits.service';

export interface UploadedVisitFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const ACCEPTED: Record<VisitFileKind, readonly string[]> = {
  COVER: VISIT_IMAGE_TYPES,
  DOCUMENT: VISIT_DOCUMENT_TYPES,
};

const bucketFor = (kind: VisitFileKind, contentType: string): BucketId =>
  kind === 'COVER' || contentType.startsWith('image/')
    ? STORAGE_BUCKETS.visitMedia.id
    : STORAGE_BUCKETS.visitDocuments.id;

/**
 * Cover photo and documents of a visit (§6.3), in private storage (§16.3). The
 * content is checked by its bytes; the object key is generated here, never taken
 * from the client. Objects of rows that no longer exist are removed after commit.
 */
@Injectable()
export class VisitFilesService {
  private readonly logger = new Logger(VisitFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: FileStore,
    private readonly visits: VisitsService,
    private readonly background: BackgroundTasks,
  ) {}

  async upload(
    principal: AuthPrincipal,
    visitId: string,
    kind: VisitFileKind,
    file: UploadedVisitFile | undefined,
    context: RequestContext,
  ): Promise<VisitDetail> {
    if (!file || file.size === 0) throw StudentErrors.fileInvalid('no file was uploaded');
    if (file.size > VISIT_FILE_MAX_BYTES) throw StudentErrors.fileTooLarge();
    const type = sniffFileType(file.buffer);
    if (!type || !ACCEPTED[kind].includes(type.contentType)) {
      throw SchedulingErrors.fileTypeNotAllowed();
    }
    if (!this.store.driver) throw SchedulingErrors.storageUnavailable();

    // Cheap checks before storing anything; repeated under lock below.
    const visit = await this.prisma.trainingVisit.findUnique({ where: { id: visitId } });
    if (!visit) throw Errors.notFound('Visit');
    if (visit.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();

    const bucket = bucketFor(kind, type.contentType);
    const objectPath = `visits/${visitId}/${randomUUID()}.${type.extension}`;
    const fileName = cleanFileName(file.originalname, `file.${type.extension}`);
    await this.store.put(bucket, objectPath, file.buffer, type.contentType);

    let replaced: { bucket: string; storagePath: string } | null = null;
    try {
      replaced = await this.prisma.$transaction(async (tx) => {
        const locked = await this.visits.lock(tx, visitId);
        if (locked.status === 'CANCELLED') throw SchedulingErrors.visitCancelled();
        let previousCover: { id: string; bucket: string; storagePath: string } | null = null;
        if (kind === 'COVER') {
          previousCover = await tx.visitFile.findFirst({
            where: { visitId, kind: 'COVER' },
            select: { id: true, bucket: true, storagePath: true },
          });
          if (previousCover) await tx.visitFile.delete({ where: { id: previousCover.id } });
        } else {
          const count = await tx.visitFile.count({ where: { visitId, kind: 'DOCUMENT' } });
          if (count >= VISIT_MAX_DOCUMENTS)
            throw SchedulingErrors.tooManyFiles(VISIT_MAX_DOCUMENTS);
        }
        const created = await tx.visitFile.create({
          data: {
            visitId,
            kind,
            bucket,
            storagePath: objectPath,
            fileName,
            contentType: type.contentType,
            sizeBytes: file.size,
            uploadedById: principal.userId,
          },
        });
        await tx.trainingVisit.update({
          where: { id: visitId },
          data: {
            detached: locked.scheduleId !== null || locked.detached,
            updatedById: principal.userId,
          },
        });
        await this.audit.record(
          {
            actor: actorOf(principal),
            action: 'visit.file_added',
            resourceType: 'visit',
            resourceId: visitId,
            outcome: 'SUCCESS',
            after: {
              fileId: created.id,
              kind,
              fileName,
              contentType: type.contentType,
              sizeBytes: file.size,
              replacedCover: previousCover !== null,
            },
            context,
          },
          tx,
        );
        return previousCover;
      });
    } catch (error) {
      this.removeLater(bucket, objectPath);
      throw error;
    }
    if (replaced) this.removeLater(replaced.bucket, replaced.storagePath);
    return this.reload(visitId);
  }

  async remove(
    principal: AuthPrincipal,
    visitId: string,
    fileId: string,
    context: RequestContext,
  ): Promise<VisitDetail> {
    const removed = await this.prisma.$transaction(async (tx) => {
      const visit = await this.visits.lock(tx, visitId);
      const file = await tx.visitFile.findFirst({ where: { id: fileId, visitId } });
      if (!file) throw Errors.notFound('File');
      await tx.visitFile.delete({ where: { id: file.id } });
      await tx.trainingVisit.update({
        where: { id: visitId },
        data: {
          detached: visit.scheduleId !== null || visit.detached,
          updatedById: principal.userId,
        },
      });
      await this.audit.record(
        {
          actor: actorOf(principal),
          action: 'visit.file_removed',
          resourceType: 'visit',
          resourceId: visitId,
          outcome: 'SUCCESS',
          before: {
            fileId: file.id,
            kind: file.kind,
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
          },
          context,
        },
        tx,
      );
      return file;
    });
    this.removeLater(removed.bucket, removed.storagePath);
    return this.reload(visitId);
  }

  private async reload(visitId: string): Promise<VisitDetail> {
    const visit = await this.prisma.trainingVisit.findUniqueOrThrow({
      where: { id: visitId },
      include: VISIT_DETAIL_INCLUDE,
    });
    return this.visits.toDetail(visit);
  }

  private removeLater(bucket: string, objectPath: string): void {
    this.background.run('remove visit file', async () => {
      await this.store.remove(bucket as BucketId, [objectPath]);
      this.logger.debug(`Removed ${bucket}/${objectPath}`);
    });
  }
}
