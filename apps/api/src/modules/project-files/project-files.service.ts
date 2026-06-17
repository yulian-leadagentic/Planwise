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

  /**
   * Project Files tab listing — unions per-project files with task-level
   * attachments so the customer sees ONE place for everything tied to the
   * project, while task attachments remain editable from the task drawer.
   *
   * Shape per row:
   *   { id, kind, name, url, fileSize, mimeType, description, createdAt,
   *     uploader, source: 'project' | 'task', taskId?, taskName? }
   *
   * `id` is namespaced (`p-123` / `t-456`) so the frontend can hand it
   * back without collisions when calling delete / download. Task-attachment
   * IDs are NOT exposed as bare numbers here — those endpoints already
   * exist on /tasks/attachments/:id and the client uses the namespaced id
   * to route correctly.
   */
  async list(projectId: number) {
    const [projectFiles, taskAttachments] = await Promise.all([
      this.prisma.projectFile.findMany({
        where: { projectId },
        include: {
          uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
        },
      }),
      this.prisma.taskAttachment.findMany({
        // Comment-level attachments (commentId IS NOT NULL) belong to the
        // Discussion thread of their task — they shouldn't appear in the
        // top-level project Files list. Otherwise every casual screenshot
        // pasted into a comment ends up cluttering the file inventory.
        where: { task: { projectId }, commentId: null },
        include: {
          uploader: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } },
          task: { select: { id: true, name: true } },
        },
      }),
    ]);

    const rows = [
      ...projectFiles.map((f: any) => ({
        id: `p-${f.id}`,
        rawId: f.id,
        source: 'project' as const,
        kind: f.kind,
        name: f.name,
        url: f.url,
        fileSize: f.fileSize,
        mimeType: f.mimeType,
        description: f.description,
        createdAt: f.createdAt,
        uploader: f.uploader,
      })),
      ...taskAttachments.map((a: any) => ({
        id: `t-${a.id}`,
        rawId: a.id,
        source: 'task' as const,
        // Task attachments are always uploads (the table only stores uploads
        // today). Hard-code `upload` so the UI renders the right icon/badge.
        kind: 'upload',
        name: a.fileName,
        url: a.fileUrl,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
        description: null,
        createdAt: a.createdAt,
        uploader: a.uploader,
        taskId: a.taskId,
        taskName: a.task?.name ?? null,
      })),
    ];

    // Sort once across the union so the "newest" view is consistent
    // regardless of source.
    rows.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return rows;
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
