import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type CommitImportRequest,
  CommitImportRequestSchema,
  IMPORT_MAX_FILE_BYTES,
  type ImportPreview,
  type ListImportsResponse,
} from '@ftms/core';
import { CurrentPrincipal, RequirePermissions } from '../../auth/decorators';
import { type AuthPrincipal } from '../../auth/principal';
import { Ctx, type RequestContext } from '../../common/request-context';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { buildImportTemplate } from './import-template';
import { ImportsService, type UploadedFile as ImportFile } from './imports.service';

const uuid = new ParseUUIDPipe({ version: '7' });

/** Spreadsheet import of student records (§4.1). */
@Controller('student-imports')
@RequirePermissions('students.import')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** The downloadable example spreadsheet. */
  @Get('template')
  @Header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('content-disposition', 'attachment; filename="ftms-students-template.xlsx"')
  @Header('cache-control', 'no-store')
  async template(): Promise<StreamableFile> {
    return new StreamableFile(await buildImportTemplate());
  }

  @Get()
  list(): Promise<ListImportsResponse> {
    return this.imports.list();
  }

  /** Upload: validates the file and returns a preview. Nothing is written to student records. */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      // In memory only (no temp files on serverless); one file, bounded size.
      limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1, fields: 5, parts: 6 },
    }),
  )
  upload(
    @CurrentPrincipal() principal: AuthPrincipal,
    @UploadedFile() file: ImportFile | undefined,
    @Ctx() context: RequestContext,
  ): Promise<ImportPreview> {
    return this.imports.upload(principal, file, context);
  }

  @Get(':id')
  preview(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
  ): Promise<ImportPreview> {
    return this.imports.preview(principal, id);
  }

  /** Writes the previewed plan, after explicit confirmation of updates and skipped rows. */
  @Post(':id/commit')
  @HttpCode(200)
  commit(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(CommitImportRequestSchema)) body: CommitImportRequest,
    @Ctx() context: RequestContext,
  ): Promise<ImportPreview> {
    return this.imports.commit(principal, id, body, context);
  }

  @Delete(':id')
  @HttpCode(204)
  async discard(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('id', uuid) id: string,
    @Ctx() context: RequestContext,
  ): Promise<void> {
    await this.imports.discard(principal, id, context);
  }
}
