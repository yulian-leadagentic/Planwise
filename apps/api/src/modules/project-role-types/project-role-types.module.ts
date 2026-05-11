import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../../common/authorization.module';
import { ProjectRoleTypesController } from './project-role-types.controller';

@Module({
  imports: [AuthorizationModule],
  controllers: [ProjectRoleTypesController],
})
export class ProjectRoleTypesModule {}
