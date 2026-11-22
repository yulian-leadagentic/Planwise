import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { AuthorizationModule } from '../../common/authorization.module';

/**
 * Permissions round 3 (2026-11-22) — AuthorizationModule supplies
 * EmployeeScopeService: every per-person report is limited to the
 * employees the caller may see (+ projects he leads, for time entries).
 */
@Module({
  imports: [AuthorizationModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
