import { Module } from '@nestjs/common';
import { NumberRangesModule } from '../number-ranges/number-ranges.module';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserSenioritiesService } from './user-seniorities.service';

@Module({
  // Phase 4 · Stage 1c — UsersService derives `userType` from the D1
  // rule via BusinessPartnersService.getHomeOrg(), so the BP module
  // must be imported (its service is already exported).
  // Round 3 — AuthorizationModule for ProjectAccessService (the
  // subordinate memo UsersService clears on org-unit / user changes).
  imports: [NumberRangesModule, BusinessPartnersModule, AuthorizationModule],
  controllers: [UsersController],
  providers: [UsersService, UserSenioritiesService],
  // UserSenioritiesService is exported so cost-calculation services
  // (projects.service, reports.service, planning.service) can resolve
  // a user's date-effective seniority for each TimeEntry.
  exports: [UsersService, UserSenioritiesService],
})
export class UsersModule {}
