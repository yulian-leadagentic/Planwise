import { Module } from '@nestjs/common';
import { ExecutionBoardController } from './execution-board.controller';
import { ExecutionBoardService } from './execution-board.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [ExecutionBoardController],
  providers: [ExecutionBoardService],
})
export class ExecutionBoardModule {}
