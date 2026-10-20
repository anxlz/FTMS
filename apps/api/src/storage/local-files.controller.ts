import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { Errors } from '../common/api-exception';
import { FileStore } from './file-store';

/** RFC 6266 filename parameters: an ASCII fallback plus the UTF-8 original. */
export const contentDisposition = (kind: 'inline' | 'attachment', fileName: string): string => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

/**
 * Serves files of the local storage driver (development and tests only) to the
 * web app. The signed, expiring token is the authorization — it is issued only
 * after the feature checked access, exactly like a Supabase signed URL.
 */
@Controller('local-files')
export class LocalFilesController {
  constructor(private readonly files: FileStore) {}

  @Public()
  @Get(':token')
  async get(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.files.readLocal(token);
    if (!file) throw Errors.notFound('File');
    res.setHeader('cache-control', 'private, max-age=600');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader(
      'content-disposition',
      file.download ? contentDisposition('attachment', file.download) : 'inline',
    );
    return new StreamableFile(file.body, { type: file.contentType, length: file.body.length });
  }
}
