import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { ExportService } from './export.service';

@Module({
  imports: [
    MulterModule.register({
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService, ExportService],
  exports: [FilesService, ExportService],
})
export class FilesModule {}
