import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs/promises';

import { PrismaService } from '../../prisma/prisma.service';
import { FilesService } from '../files/files.service';

@Injectable()
export class ProjectFilesService {
  private uploadDir: string;

  constructor(
    private prisma: PrismaService,
    private files: FilesService,
    config: ConfigService,
  ) {
    this.uploadDir = config.get('UPLOAD_DIR', './uploads');
  }

  async list(projectId: number) {
    return this.prisma.projectFile.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }

  async findOne(projectId: number, id: number) {
    const file = await this.prisma.projectFile.findFirst({ where: { id, projectId } });
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  async addUpload(
    projectId: number,
    userId: number,
    file: Express.Multer.File,
    description?: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const { url, originalName } = await this.files.uploadFile(file, 'projects');
    return this.prisma.projectFile.create({
      data: {
        projectId,
        kind: 'upload',
        name: originalName,
        url,
        fileSize: file.size,
        mimeType: file.mimetype,
        description: description || null,
        uploadedBy: userId,
      },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }

  async addLink(
    projectId: number,
    userId: number,
    body: { name: string; url: string; description?: string },
  ) {
    if (!body?.url) throw new BadRequestException('url is required');
    if (!body?.name) throw new BadRequestException('name is required');
    return this.prisma.projectFile.create({
      data: {
        projectId,
        kind: 'link',
        name: body.name.slice(0, 255),
        url: body.url.slice(0, 1000),
        description: body.description?.slice(0, 1000) || null,
        uploadedBy: userId,
      },
      include: {
        uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
      },
    });
  }

  async remove(projectId: number, id: number) {
    const file = await this.findOne(projectId, id);
    if (file.kind === 'upload') {
      // Best-effort disk cleanup; missing file shouldn't block DB delete.
      const diskPath = path.join(this.uploadDir, 'projects', path.basename(file.url));
      await fs.unlink(diskPath).catch(() => undefined);
    }
    await this.prisma.projectFile.delete({ where: { id } });
    return { message: 'File removed' };
  }

  /**
   * Resolve the absolute disk path for an uploaded file, with path-traversal
   * guard so a malicious DB row can't escape the project upload root.
   */
  async resolveUploadPath(projectId: number, id: number): Promise<{ path: string; file: { name: string; mimeType: string | null } }> {
    const file = await this.findOne(projectId, id);
    if (file.kind !== 'upload') throw new BadRequestException('Not a downloadable upload');

    const root = path.resolve(this.uploadDir, 'projects');
    const target = path.resolve(root, path.basename(file.url));
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new BadRequestException('Invalid file path');
    }
    return { path: target, file: { name: file.name, mimeType: file.mimeType } };
  }
}
