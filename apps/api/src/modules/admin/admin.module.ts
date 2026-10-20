import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
import { ReportsController } from './reports.controller';
import { BackfillsController } from './backfills.controller';
import { AdminUsersController } from './users.controller';
import { AuthorizationModule } from '../../common/authorization.module';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';
import { UsersModule } from '../users/users.module';

@Module({
  // People UX M6 — ReportsController re-uses BusinessPartnersService for
  // the home-org resolver, so we import the BP module (which exports
  // the service) rather than duplicate the logic.
  //
  // B5-3 (2026-10-20) — BackfillsController's user-business-partner
  // backfill reuses `UsersService.ensureBpForUser` +
  // `syncEmployeeBpRole` so the historical 26 orphan users land the
  // exact same BP shape that `UsersService.create` writes today.
  imports: [AuthorizationModule, BusinessPartnersModule, UsersModule],
  controllers: [
    RolesController,
    ActivityLogController,
    EnumsController,
    ConfigController,
    ReportsController,
    BackfillsController,
    // §14 RBAC multi-role (2026-10-18) — PATCH /admin/users/:id/roles
    // for the multi-select-chip UI on the user edit modal.
    AdminUsersController,
  ],
})
export class AdminModule {}
