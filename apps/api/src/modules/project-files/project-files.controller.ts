import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';

import { ProjectFilesService } from './project-files.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermissions } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Project Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/files')
export class ProjectFilesController {
  constructor(private readonly service: ProjectFilesService) {}

  @Get()
  @RequirePermissions({ module: 'projects/files', action: 'read' })
  @ApiOperation({ summary: 'List files attached to a project' })
  list(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.service.list(projectId);
  }

  @Post('upload')
  @RequirePermissions({ module: 'projects/files', action: 'write' })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        description: { type: 'string' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload a file to a project' })
  upload(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('description') description?: string,
  ) {
    return this.service.addUpload(projectId, user.id, file, description);
  }

  @Post('link')
  @RequirePermissions({ module: 'projects/files', action: 'write' })
  @ApiOperation({ summary: 'Add an external link / network path' })
  addLink(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: any,
    @Body() body: { name: string; url: string; description?: string },
  ) {
    return this.service.addLink(projectId, user.id, body);
  }

  @Delete(':fileId')
  @RequirePermissions({ module: 'projects/files', action: 'delete' })
  @ApiOperation({ summary: 'Remove a project file or link' })
  remove(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
  ) {
    return this.service.remove(projectId, fileId);
  }

  @Get(':fileId/download')
  @RequirePermissions({ module: 'projects/files', action: 'read' })
  @ApiOperation({ summary: 'Stream an uploaded project file' })
  async download(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { path, file } = await this.service.resolveUploadPath(projectId, fileId);
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
    });
    return new StreamableFile(fs.createReadStream(path));
  }
}
