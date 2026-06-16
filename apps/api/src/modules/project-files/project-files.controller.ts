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
  BadRequestException,
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

/**
 * Build an RFC 5987-compliant Content-Disposition header. Browsers fall back
 * to the ASCII `filename` if they can't read `filename*`; modern browsers
 * use `filename*` and decode UTF-8 percent-escapes back to the real chars.
 */
/**
 * Tolerate both the legacy integer `:fileId` and the new namespaced form
 * `p-<n>` introduced when the Files tab list endpoint started unioning
 * project files with task attachments (the namespacing prevents id
 * collisions in the response). A frontend running cached old code may
 * still pass `p-7` or even `t-7`; we accept the project-file form, reject
 * the task form (those go via /tasks/attachments/:id), and reject garbage.
 */
function parseProjectFileId(raw: string): number {
  if (raw == null || raw === '') {
    throw new BadRequestException('File id is required');
  }
  let id = raw;
  if (id.startsWith('p-')) id = id.slice(2);
  if (id.startsWith('t-')) {
    throw new BadRequestException(
      'This is a task attachment — use /tasks/attachments/:id to manage it',
    );
  }
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException(`Invalid file id: ${raw}`);
  }
  return n;
}

function contentDispositionAttachment(name: string): string {
  // ASCII fallback — strip non-ASCII so the legacy header is always valid,
  // and quote-escape anything that would break the quoted-string syntax.
  const asciiFallback = name
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_') || 'download';
  // RFC 5987: filename*=UTF-8''<percent-encoded>
  const utf8Encoded = encodeURIComponent(name);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

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
    @Param('fileId') rawFileId: string,
  ) {
    const fileId = parseProjectFileId(rawFileId);
    return this.service.remove(projectId, fileId);
  }

  @Get(':fileId/download')
  @RequirePermissions({ module: 'projects/files', action: 'read' })
  @ApiOperation({ summary: 'Stream an uploaded project file' })
  async download(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('fileId') rawFileId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const fileId = parseProjectFileId(rawFileId);
    const { path, file } = await this.service.resolveUploadPath(projectId, fileId);
    res.set({
      'Content-Type': file.mimeType || 'application/octet-stream',
      // RFC 5987: send both an ASCII fallback and a UTF-8 filename* so
      // browsers preserve Hebrew / Cyrillic / Asian characters on download.
      'Content-Disposition': contentDispositionAttachment(file.name),
    });
    return new StreamableFile(fs.createReadStream(path));
  }
}
