import { Module } from '@nestjs/common';
import { ProjectFilesController } from './project-files.controller';
import { ProjectFilesService } from './project-files.service';
import { FilesModule } from '../files/files.module';
import { AuthorizationModule } from '../../common/authorization.module';

@Module({
  imports: [FilesModule, AuthorizationModule],
  controllers: [ProjectFilesController],
  providers: [ProjectFilesService],
})
export class ProjectFilesModule {}
