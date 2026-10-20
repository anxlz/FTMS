import { Global, Module } from '@nestjs/common';
import { FileStore } from './file-store';
import { LocalFilesController } from './local-files.controller';
import { StorageService } from './storage.service';

@Global()
@Module({
  controllers: [LocalFilesController],
  providers: [StorageService, FileStore],
  exports: [StorageService, FileStore],
})
export class StorageModule {}
