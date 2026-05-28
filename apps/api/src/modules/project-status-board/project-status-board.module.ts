import { Module } from '@nestjs/common';
import { ProjectStatusBoardController } from './project-status-board.controller';

@Module({
  controllers: [ProjectStatusBoardController],
})
export class ProjectStatusBoardModule {}
