import { Module } from '@nestjs/common';
import { ProjectStatusBoardController } from './project-status-board.controller';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [AuthorizationModule],
  controllers: [ProjectStatusBoardController],
})
export class ProjectStatusBoardModule {}
