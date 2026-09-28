import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
import { ReportsController } from './reports.controller';
import { BackfillsController } from './backfills.controller';
import { AuthorizationModule } from '../../common/authorization.module';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';

@Module({
  // People UX M6 — ReportsController re-uses BusinessPartnersService for
  // the home-org resolver, so we import the BP module (which exports
  // the service) rather than duplicate the logic.
  imports: [AuthorizationModule, BusinessPartnersModule],
  controllers: [
    RolesController,
    ActivityLogController,
    EnumsController,
    ConfigController,
    ReportsController,
    BackfillsController,
  ],
})
export class AdminModule {}
