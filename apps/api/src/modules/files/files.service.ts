import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

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

    const targetDir = folder
      ? path.join(this.uploadDir, folder)
      : this.uploadDir;

    await fs.mkdir(targetDir, { recursive: true });

    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filepath = path.join(targetDir, filename);

    // Resize images if they are too large
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
    if (imageExtensions.includes(ext)) {
      const resized = await sharp(file.buffer)
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();

      await fs.writeFile(filepath, resized);

      // Generate thumbnail
      const thumbDir = path.join(targetDir, 'thumbs');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumb = await sharp(file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .toBuffer();
      await fs.writeFile(path.join(thumbDir, filename), thumb);
    } else {
      await fs.writeFile(filepath, file.buffer);
    }

    const url = `/${folder ? folder + '/' : ''}${filename}`;

    return { url, originalName: file.originalname };
  }

  async uploadMultiple(files: Express.Multer.File[], folder?: string) {
    const results = [];
    for (const file of files) {
      const result = await this.uploadFile(file, folder);
      results.push(result);
    }
    return results;
  }
}
