import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
// TEMPORARY (QA3 Wave-1 Commit 3B): removed at Wave-1 close alongside the
// old integrity endpoint. Atomic, staging-only, dryRun-reversible split
// of project_types / service_types — see the controller header.
import { Qa3ReconciliationController } from './qa3-reconciliation.controller';
import { Qa3ThreeCBackfillController } from './qa3-3c-backfill.controller';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [
    RolesController,
    ActivityLogController,
    EnumsController,
    ConfigController,
    Qa3ReconciliationController,
    Qa3ThreeCBackfillController,
  ],
})
export class AdminModule {}
