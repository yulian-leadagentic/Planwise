import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { ActivityLogController } from './activity-log.controller';
import { EnumsController } from './enums.controller';
import { ConfigController } from './config.controller';

@Module({
  controllers: [RolesController, ActivityLogController, EnumsController, ConfigController],
})
export class AdminModule {}
