/**
 * BM2-28 (QA6) — the upload path end to end over HTTP (Nest app in
 * memory, no database): multipart field name, size cap, the JSON limit
 * of the later wizard steps, and the permission guard the wizard's
 * buttons must agree with.
 */
import { Body, Controller, ExecutionContext, INestApplication, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { PermissionDeniedException } from '../../../common/errors/permission-denied';
import { ProjectAccessService } from '../../../common/services/project-access.service';
import {
  ContactsImportController,
  decodeUploadName,
  uploadProblem,
} from './contacts-import.controller';
import { ContactsTriageService } from './triage.service';
import { ContactsHeaderDetectionService } from './header-detection.service';
import { ContactsMappingPresetService } from './mapping-preset.service';
import { ContactsResolveService } from './resolve.service';
import { ContactsCommitService } from './commit.service';
import {
  CONTACTS_IMPORT_MAX_FILE_BYTES,
  CONTACTS_IMPORT_ROUTE_PREFIX,
  contactsImportJsonParser,
} from './import-limits';
import { HEBREW_HEADER, PEOPLE } from '../../../testing/contacts-import-fixtures';

const perm = (route: string, flags: { canRead?: boolean; canWrite?: boolean }) => ({
  module: { route, name: route.replace(/^\//, '') },
  canRead: !!flags.canRead,
  canWrite: !!flags.canWrite,
  canDelete: false,
  canApprove: false,
  canExport: false,
});
const IMPORTER = { id: 4, isAdmin: false, roleModules: [perm('/data-import/contacts', { canRead: true, canWrite: true })] };
const PARENT_IMPORTER = { id: 5, isAdmin: false, roleModules: [perm('/data-import', { canRead: true, canWrite: true })] };
const CHILD_DENIED = {
  id: 6,
  isAdmin: false,
  roleModules: [perm('/data-import', { canRead: true, canWrite: true }), perm('/data-import/contacts', {})],
};
const ADMIN_WITHOUT_GRANT = { id: 1, isAdmin: true, roleModules: [perm('/admin', { canRead: true, canWrite: true })] };

/** A route outside the wizard, to prove the default 100 KB JSON limit still applies there. */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { size: JSON.stringify(body).length };
  }
}

describe('contacts import over HTTP', () => {
  let app: INestApplication;
  let currentUser: any = IMPORTER;
  const previewSheet = jest.fn(async (input: any) => ({ rows: input.sheet.rows.length }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContactsImportController, EchoController],
      providers: [
        ContactsTriageService,
        ContactsHeaderDetectionService,
        { provide: ContactsMappingPresetService, useValue: {} },
        { provide: ContactsResolveService, useValue: { previewSheet } },
        { provide: ContactsCommitService, useValue: {} },
        { provide: ProjectAccessService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = currentUser;
          return true;
        },
      })
      .compile();
    // logger off: the expected 413s would otherwise print stack traces.
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    // Same wiring as main.ts.
    app.use(CONTACTS_IMPORT_ROUTE_PREFIX, contactsImportJsonParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = IMPORTER;
  });

  const csv = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([HEBREW_HEADER, ...PEOPLE].map((r) => r.join(',')).join('\r\n'), 'utf8'),
  ]);

  it('uploads a file in the "file" multipart field and returns sheets + grades (the wizard request)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', csv, { filename: 'contacts.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body.triage).toMatchObject({ kind: 'tabular', reader: 'csv', filename: 'contacts.csv' });
    expect(res.body.triage.sheets[0].rows[0]).toEqual(HEBREW_HEADER);
    expect(res.body.grades[0].verdict).toBe('auto');
  });

  it('a Hebrew file name survives multipart (Multer decodes names as Latin-1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', csv, { filename: 'אנשי קשר.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body.triage.filename).toBe('אנשי קשר.csv');
  });

  it('no file (wrong field name) → a reason the wizard shows, not a 500', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .field('other', 'x')
      .expect(201);
    expect(res.body.triage).toEqual({ kind: 'reject', reason: 'No file was received. Choose the file again and retry.' });
  });

  it('a file over the cap is cut off by Multer (413) instead of being buffered whole', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', Buffer.alloc(CONTACTS_IMPORT_MAX_FILE_BYTES + 1, 0x41), { filename: 'big.csv' })
      .expect(413);
  });

  it('a 20 MB file under the cap reaches the reader (the old cap rejected anything over 5 MB)', async () => {
    // An image-heavy 20 MB file: read and answered on its merits.
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20 * 1024 * 1024)]);
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', big, { filename: 'scan.xlsx' })
      .expect(201);
    expect(res.body.triage.kind).toBe('reject');
    expect(res.body.triage.reason).toMatch(/image \(PNG\)/);
  });

  it('Preview accepts a sheet far above Express\'s 100 KB JSON default (was 413)', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => [`Test Person ${i}`, `test${i}@example.com`, '0501234567']);
    const body = { sheet: { name: 'Sheet1', rows }, mapping: { contact: 'Name' }, headerRowIndex: 0 };
    expect(JSON.stringify(body).length).toBeGreaterThan(300 * 1024);
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/preview')
      .send(body)
      .expect(201);
    expect(res.body).toEqual({ rows: 6000 });
  });

  it('other routes keep the default JSON limit', async () => {
    await request(app.getHttpServer()).post('/api/v1/echo').send({ a: 'x'.repeat(10) }).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/echo')
      .send({ a: 'x'.repeat(200 * 1024) })
      .expect(413);
  });

  it('an Admin without the "Import Contacts" grant is refused (data-import has no Admin bypass)', async () => {
    currentUser = ADMIN_WITHOUT_GRANT;
    const res = await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', csv, { filename: 'contacts.csv' })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/permission/i);
  });

  it('a grant on the parent data-import row is enough; an explicit deny on the child wins', async () => {
    currentUser = PARENT_IMPORTER;
    await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', csv, { filename: 'contacts.csv' })
      .expect(201);
    currentUser = CHILD_DENIED;
    await request(app.getHttpServer())
      .post('/api/v1/data-import/contacts/upload')
      .attach('file', csv, { filename: 'contacts.csv' })
      .expect(403);
  });
});

describe('guard metadata: every wizard step needs write on data-import/contacts', () => {
  const guard = new RolesGuard(new Reflector());
  const ctx = (user: any, handler: (...args: any[]) => unknown) =>
    ({
      getHandler: () => handler,
      getClass: () => ContactsImportController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;
  const proto = ContactsImportController.prototype;

  it.each(['upload', 'triageFile', 'preview', 'commit'] as const)('%s', (method) => {
    const handler = proto[method] as (...args: any[]) => unknown;
    expect(guard.canActivate(ctx(IMPORTER, handler))).toBe(true);
    expect(guard.canActivate(ctx(PARENT_IMPORTER, handler))).toBe(true);
    expect(() => guard.canActivate(ctx(ADMIN_WITHOUT_GRANT, handler))).toThrow(PermissionDeniedException);
    expect(() => guard.canActivate(ctx(CHILD_DENIED, handler))).toThrow(PermissionDeniedException);
  });
});

describe('upload helpers', () => {
  it('uploadProblem names the cap in MB and never uses a long dash', () => {
    expect(uploadProblem(undefined)).toMatch(/No file was received/);
    expect(uploadProblem({ buffer: Buffer.alloc(10) })).toBeNull();
    const msg = uploadProblem({ buffer: { length: CONTACTS_IMPORT_MAX_FILE_BYTES + 1 } as Buffer });
    expect(msg).toMatch(/larger than 25 MB/);
    expect(msg).not.toMatch(/[–—]/);
  });

  it('decodeUploadName re-decodes a Latin-1 mangled UTF-8 name and leaves others alone', () => {
    expect(decodeUploadName(Buffer.from('אנשי קשר.xlsx', 'utf8').toString('latin1'))).toBe('אנשי קשר.xlsx');
    expect(decodeUploadName('contacts.xlsx')).toBe('contacts.xlsx');
    expect(decodeUploadName('Café.xlsx')).toBe('Café.xlsx');
    expect(decodeUploadName(undefined)).toBeUndefined();
  });
});
