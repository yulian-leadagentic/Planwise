import { Module } from '@nestjs/common';

import { LookupsController } from './lookups.controller';
import { AuthorizationModule } from '../../common/authorization.module';
import { BusinessPartnersModule } from '../business-partners/business-partners.module';

/**
 * B4 (P0, 2026-10-20) — thin module wiring the read-only lookup
 * endpoints for the New Project form. PrismaService resolves via the
 * global PrismaModule; OrgUnitService comes from AuthorizationModule
 * (which already exports it to OrgModule) and BusinessPartnersService
 * from BusinessPartnersModule (also already exported for the
 * ReportsController home-org re-use). No new providers are declared
 * here — this is pure routing + guard composition.
 */
@Module({
  imports: [AuthorizationModule, BusinessPartnersModule],
  controllers: [LookupsController],
})
export class LookupsModule {}
