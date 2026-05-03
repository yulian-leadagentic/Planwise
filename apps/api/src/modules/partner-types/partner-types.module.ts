import { Module } from '@nestjs/common';
import { PartnerTypesController } from './partner-types.controller';
import { AuditInterceptor } from '../../common/interceptors/audit.interceptor';

@Module({
  controllers: [PartnerTypesController],
  providers: [AuditInterceptor],
})
export class PartnerTypesModule {}
