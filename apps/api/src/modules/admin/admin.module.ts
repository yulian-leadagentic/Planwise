import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [RolesController, ActivityLogController, EnumsController, ConfigController],
})
export class AdminModule {}
