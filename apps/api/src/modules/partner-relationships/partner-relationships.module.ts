import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { PartnerRelationshipsController } from './partner-relationships.controller';
import { PartnerRelationshipsService } from './partner-relationships.service';

@Module({
  imports: [AuthorizationModule],
  controllers: [PartnerRelationshipsController],
  providers: [PartnerRelationshipsService],
  exports: [PartnerRelationshipsService],
})
export class PartnerRelationshipsModule {}
