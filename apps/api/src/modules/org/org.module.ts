import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';
import { OrgUnitsController } from './org-units.controller';

/**
 * OrgModule — HTTP surface for the org-tree admin. The heavy lifting
 * (path invariant, cycle protection, cache invalidation) lives in
 * OrgUnitService inside AuthorizationModule; this module just wires
 * the controller so it can inject that service.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [OrgUnitsController],
})
export class OrgModule {}
