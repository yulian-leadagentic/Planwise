import { Module } from '@nestjs/common';
import { BusinessPartnerRelationshipsController } from './business-partner-relationships.controller';
import { BusinessPartnerRelationshipsService } from './business-partner-relationships.service';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

@Module({
  controllers: [BusinessPartnerRelationshipsController],
  providers: [BusinessPartnerRelationshipsService, AuditInterceptor],
  exports: [BusinessPartnerRelationshipsService],
})
export class BusinessPartnerRelationshipsModule {}
