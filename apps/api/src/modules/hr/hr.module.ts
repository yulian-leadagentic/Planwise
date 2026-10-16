import { Module } from '@nestjs/common';

import { HrController } from './hr.controller';
import { HrService } from './hr.service';
import { HrMonthlyService } from './hr-monthly.service';
import { FilesModule } from '../files/files.module';

/**
 * HR Phase A3+B3+C2 (2026-10-16) — mounts the `/hr/*` controller + its
 * two services (catalog/employee CRUD + monthly engine).
 *
 * FilesModule is imported so HrService can inject FilesService for the
 * EmployeeAttachment multipart upload path. ActivityLogService is
 * provided globally by ActivityLogModule.
 *
 * HrMonthlyService (Phase C2) is exported so a future consolidated
 * accounting-export module (Phase D) can wire into the same engine.
 */
@Module({
  imports: [FilesModule],
  controllers: [HrController],
  providers: [HrService, HrMonthlyService],
  exports: [HrMonthlyService],
})
export class HrModule {}
