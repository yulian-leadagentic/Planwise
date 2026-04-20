import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

const ALLOWED_FOLDERS = new Set([
  'attachments',
  'avatars',
  'projects',
  'tasks',
  'documents',
]);

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
]);

const MAX_FILENAME_LEN = 200;

function safeFolder(folder?: string): string | undefined {
  if (!folder) return undefined;
  // Reject anything containing path separators or null bytes
  if (folder.includes('/') || folder.includes('\\') || folder.includes('\0') || folder.includes('..')) {
    throw new BadRequestException('Invalid folder name');
  }
  if (!ALLOWED_FOLDERS.has(folder)) {
    throw new BadRequestException(`Folder must be one of: ${[...ALLOWED_FOLDERS].join(', ')}`);
  }
  return folder;
}

@Injectable()
export class FilesService {
  private uploadDir: string;

  constructor(private configService: ConfigService) {
    this.uploadDir = this.configService.get('UPLOAD_DIR', './uploads');
  }

  async uploadFile(file: Express.Multer.File, folder?: string): Promise<{ url: string; originalName: string }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`File type not allowed: ${file.mimetype}`);
    }

    const safe = safeFolder(folder);
    const targetDir = safe
      ? path.join(this.uploadDir, safe)
      : this.uploadDir;

    // Defense in depth: ensure resolved targetDir stays within uploadDir
    const resolvedTarget = path.resolve(targetDir);
    const resolvedRoot = path.resolve(this.uploadDir);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
      throw new BadRequestException('Invalid folder path');
    }

    await fs.mkdir(targetDir, { recursive: true });

    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filepath = path.join(targetDir, filename);

    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    if (imageExtensions.includes(ext)) {
      const resized = await sharp(file.buffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();

      await fs.writeFile(filepath, resized);

      const thumbDir = path.join(targetDir, 'thumbs');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumb = await sharp(file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .toBuffer();
      await fs.writeFile(path.join(thumbDir, filename), thumb);
    } else {
      await fs.writeFile(filepath, file.buffer);
    }

    const url = `/${safe ? safe + '/' : ''}${filename}`;
    const originalName = file.originalname.slice(0, MAX_FILENAME_LEN).replace(/[\r\n\0]/g, '');

    return { url, originalName };
  }

  async uploadMultiple(files: Express.Multer.File[], folder?: string) {
    const results: { url: string; originalName: string }[] = [];
    for (const file of files) {
      const result = await this.uploadFile(file, folder);
      results.push(result);
    }
    return results;
  }
}
