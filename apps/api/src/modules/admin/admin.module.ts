import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
import { LagReasonsController } from './lag-reasons.controller';
import { ReportsController } from './reports.controller';
import { BackfillsController } from './backfills.controller';
import { AdminUsersController } from './users.controller';
import { AuthorizationModule } from '../../common/authorization.module';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';
import { UsersModule } from '../users/users.module';
import { ProjectDeliverablesModule } from '../project-deliverables/project-deliverables.module';
import { P1CopiesToRefsService } from './p1-copies-to-refs.service';
import { Qa6AssigneesToTeamService } from './qa6-assignees-to-team.service';
import { ProjectPartnerRolesModule } from '../project-partner-roles/project-partner-roles.module';
import { Qa6OperationsGrantsController } from './qa6-operations-grants.controller';
import { Qa6OperationsGrantsService } from './qa6-operations-grants.service';

@Module({
  // People UX M6 — ReportsController re-uses BusinessPartnersService for
  // the home-org resolver, so we import the BP module (which exports
  // the service) rather than duplicate the logic.
  //
  // B5-3 (2026-10-20) — BackfillsController's user-business-partner
  // backfill reuses `UsersService.ensureBpForUser` +
  // `syncEmployeeBpRole` so the historical 26 orphan users land the
  // exact same BP shape that `UsersService.create` writes today.
  //
  // B2.5 (2026-11-05) — BackfillsController's
  // materialize-project-deliverables endpoint delegates to
  // `ProjectDeliverablesService.materializeFromTasks` so the admin
  // backfill and the apply-template path can no longer drift.
  //
  // QA6 (2026-11-25) — ProjectPartnerRolesModule for the
  // qa6-assignees-to-team backfill (upsertProjectMemberRelationship).
  imports: [AuthorizationModule, BusinessPartnersModule, UsersModule, ProjectDeliverablesModule, ProjectPartnerRolesModule],
  controllers: [
    RolesController,
    ActivityLogController,
    EnumsController,
    ConfigController,
    // B1 (QA-FIX-ALL 2026-11-04) — standalone controller for the
    // LagReason catalog. Shares the `/admin/config` prefix.
    LagReasonsController,
    ReportsController,
    BackfillsController,
    // §14 RBAC multi-role (2026-10-18) — PATCH /admin/users/:id/roles
    // for the multi-select-chip UI on the user edit modal.
    AdminUsersController,
    // QA6 P7 (PR-056) — POST /admin/backfills/qa6-operations-grants.
    Qa6OperationsGrantsController,
  ],
  // P1 (2026-11-15) — planner + executor behind
  // `POST /admin/backfills/p1-copies-to-refs`. Kept as a service (not
  // inline in BackfillsController) so the plan is unit-tested and the
  // dry-run script can share its pure functions. PrismaService comes
  // from the global PrismaModule, like every controller above.
  providers: [P1CopiesToRefsService, Qa6AssigneesToTeamService, Qa6OperationsGrantsService],
})
export class AdminModule {}
