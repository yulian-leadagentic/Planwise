import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import { FilesService } from './files.service';

// Mock fs operations so tests don't touch the filesystem
jest.mock('fs/promises');
jest.mock('sharp', () => {
  return jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('image-data')),
  }));
});

/**
 * FilesService is a security hot-spot: it takes user-supplied folder
 * names and writes files to disk. Tests lock down the path-traversal
 * defense + MIME allowlist.
 */
describe('FilesService', () => {
  let service: FilesService;

  beforeEach(async () => {
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FilesService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k, d) => d) },
        },
      ],
    }).compile();

    service = moduleRef.get(FilesService);
  });

  const fakeFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
    ({
      originalname: 'test.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('hello'),
      size: 5,
      fieldname: 'file',
      encoding: '7bit',
      stream: null as any,
      destination: '',
      filename: '',
      path: '',
      ...overrides,
    } as any);

  describe('path traversal defense', () => {
    it('rejects a folder containing ../', async () => {
      await expect(
        service.uploadFile(fakeFile(), '../etc'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a folder with a forward slash', async () => {
      await expect(
        service.uploadFile(fakeFile(), 'attachments/evil'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a folder with a backslash', async () => {
      await expect(
        service.uploadFile(fakeFile(), 'attachments\\evil'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a folder with a null byte', async () => {
      await expect(
        service.uploadFile(fakeFile(), 'attachments\0evil'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a folder not in the allowlist', async () => {
      await expect(
        service.uploadFile(fakeFile(), 'arbitrary-folder'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('MIME allowlist', () => {
    it('rejects executable files', async () => {
      await expect(
        service.uploadFile(fakeFile({ mimetype: 'application/x-msdownload' }), 'attachments'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects HTML (XSS risk if served)', async () => {
      await expect(
        service.uploadFile(fakeFile({ mimetype: 'text/html' }), 'attachments'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts PDFs', async () => {
      const result = await service.uploadFile(
        fakeFile({ mimetype: 'application/pdf' }),
        'attachments',
      );
      expect(result.url).toMatch(/^\/attachments\/[a-f0-9-]+\.pdf$/);
    });

    it('accepts images and generates thumbnail', async () => {
      const result = await service.uploadFile(
        fakeFile({ originalname: 'photo.jpg', mimetype: 'image/jpeg' }),
        'avatars',
      );
      expect(result.url).toMatch(/^\/avatars\/[a-f0-9-]+\.jpg$/);
      // Main image + thumbnail = 2 writes
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('filename sanitization', () => {
    it('truncates extremely long filenames', async () => {
      const longName = 'a'.repeat(500) + '.pdf';
      const result = await service.uploadFile(
        fakeFile({ originalname: longName, mimetype: 'application/pdf' }),
        'attachments',
      );
      expect(result.originalName.length).toBeLessThanOrEqual(200);
    });

    it('strips newlines and null bytes from originalName', async () => {
      const result = await service.uploadFile(
        fakeFile({ originalname: 'ev\r\nil\0.pdf', mimetype: 'application/pdf' }),
        'attachments',
      );
      expect(result.originalName).not.toMatch(/[\r\n\0]/);
    });
  });

  it('throws when no file provided', async () => {
    await expect(service.uploadFile(undefined as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
