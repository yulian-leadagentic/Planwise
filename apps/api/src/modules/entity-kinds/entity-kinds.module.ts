import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { EntityKindsController } from './entity-kinds.controller';

@Module({
  imports: [AuthorizationModule],
  controllers: [EntityKindsController],
})
export class EntityKindsModule {}
