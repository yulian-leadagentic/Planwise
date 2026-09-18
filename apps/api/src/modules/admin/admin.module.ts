import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
// TEMPORARY (QA3 Wave-1 Commit 2 · Failure B investigation): remove once
// the cleanup migration lands and Wave-1 closes. See the controller header
// for scope. Keeping it in AdminModule (not a new module) minimises the
// surface area and makes deletion a one-line reversal.
import { Qa3IntegrityController } from './qa3-integrity.controller';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [
    RolesController,
    ActivityLogController,
    EnumsController,
    ConfigController,
    Qa3IntegrityController,
  ],
})
export class AdminModule {}
