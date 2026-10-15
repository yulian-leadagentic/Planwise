import { Module } from '@nestjs/common';

import { HrController } from './hr.controller';
import { HrService } from './hr.service';
import { FilesModule } from '../files/files.module';

/**
 * HR Phase A3+B3 (2026-10-15) — mounts the `/hr/*` controller + service.
 *
 * FilesModule is imported so HrService can inject FilesService for the
 * EmployeeAttachment multipart upload path. ActivityLogService is
 * provided globally by ActivityLogModule.
 */
@Module({
  imports: [FilesModule],
  controllers: [HrController],
  providers: [HrService],
})
export class HrModule {}
