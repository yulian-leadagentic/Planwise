/**
 * BM2-28 (QA6) — the upload path end to end over HTTP (Nest app in
 * memory, no database): multipart field name, size cap, the JSON limit
 * of the later wizard steps, and the permission guard the wizard's
 * buttons must agree with. Review 2: the auth gate in front of the JSON
 * parser (B4), the multipart limits and their messages (B5).
 */
import { Body, Controller, ExecutionContext, INestApplication, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Readable } from 'stream';
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
  CONTACTS_FILE_TOO_LARGE_MESSAGE,
  CONTACTS_IMPORT_MAX_FILE_BYTES,
  CONTACTS_IMPORT_ROUTE_PREFIX,
  contactsImportAuthGate,
  contactsImportJsonParser,
} from './import-limits';

/** Test-only signing secret (the app reads JWT_ACCESS_SECRET from its config). */
const TEST_SECRET = 'contacts-import-spec-secret-0123456789abcdef';
const jwt = new JwtService({ secret: TEST_SECRET });
const TOKEN = jwt.sign({ sub: 4, email: 'importer@example.com', roleId: 2 }, { expiresIn: '5m' });
const auth = { Authorization: `Bearer ${TOKEN}` };
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
  // Wraps the real JSON parser to see whether it ever ran.
  const realParser = contactsImportJsonParser();
  const parserRan = jest.fn();

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
    // Same wiring as main.ts: auth gate, then the larger JSON parser.
    app.use(
      CONTACTS_IMPORT_ROUTE_PREFIX,
      contactsImportAuthGate((token) => jwt.verify(token)),
      function contactsImportJsonSpy(req: any, res: any, next: any) {
        parserRan();
        return realParser(req, res, next);
      },
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentUser = IMPORTER;
    parserRan.mockClear();
    previewSheet.mockClear();
  });

  /** Every wizard request carries the access token, as the web client does. */
  const post = (path: string) => request(app.getHttpServer()).post(`/api/v1/data-import/contacts/${path}`).set(auth);

  const csv = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([HEBREW_HEADER, ...PEOPLE].map((r) => r.join(',')).join('\r\n'), 'utf8'),
  ]);

  it('uploads a file in the "file" multipart field and returns sheets + grades (the wizard request)', async () => {
    const res = await post('upload')
      .attach('file', csv, { filename: 'contacts.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body.triage).toMatchObject({ kind: 'tabular', reader: 'csv', filename: 'contacts.csv' });
    expect(res.body.triage.sheets[0].rows[0]).toEqual(HEBREW_HEADER);
    expect(res.body.grades[0].verdict).toBe('auto');
  });

  it('a Hebrew file name survives multipart (Multer decodes names as Latin-1)', async () => {
    const res = await post('upload')
      .attach('file', csv, { filename: 'אנשי קשר.csv', contentType: 'text/csv' })
      .expect(201);
    expect(res.body.triage.filename).toBe('אנשי קשר.csv');
  });

  it('no file (wrong field name) → a reason the wizard shows, not a 500', async () => {
    const res = await post('upload')
      .field('other', 'x')
      .expect(201);
    expect(res.body.triage).toEqual({ kind: 'reject', reason: 'No file was received. Choose the file again and retry.' });
  });

  it('a file over the cap is cut off by Multer: 413 with the clear message (review 2, B5)', async () => {
    const res = await post('upload')
      .attach('file', Buffer.alloc(CONTACTS_IMPORT_MAX_FILE_BYTES + 1, 0x41), { filename: 'big.csv' })
      .expect(413);
    expect(res.body.message).toBe(CONTACTS_FILE_TOO_LARGE_MESSAGE);
    expect(res.body.message).toMatch(/larger than 25 MB/);
    expect(res.body.message).not.toMatch(/[–—]/);
  });

  describe('multipart limits (review 2, B5): one file part, at most the "filename" field', () => {
    it('the optional filename field still works', async () => {
      const res = await post('upload')
        .field('filename', 'אנשי קשר.csv')
        .attach('file', csv, { filename: 'x.csv', contentType: 'text/csv' })
        .expect(201);
      expect(res.body.triage.filename).toBe('אנשי קשר.csv');
    });

    it('a second file is refused in words (400)', async () => {
      const res = await post('upload')
        .attach('file', csv, { filename: 'a.csv' })
        .attach('file', csv, { filename: 'b.csv' })
        .expect(400);
      expect(res.body.message).toMatch(/send one file, in the "file" field/);
    });

    it('extra text fields are refused (fields: 2, parts: 3)', async () => {
      const res = await post('upload')
        .field('a', '1')
        .field('b', '2')
        .field('c', '3')
        .attach('file', csv, { filename: 'a.csv' })
        .expect(400);
      expect(res.body.message).toMatch(/not what the wizard expects/);
    });

    it('an oversized text field is refused (fieldSize: 1024)', async () => {
      const res = await post('upload')
        .field('filename', 'x'.repeat(2000))
        .attach('file', csv, { filename: 'a.csv' })
        .expect(400);
      expect(res.body.message).toMatch(/not what the wizard expects/);
    });
  });

  it('a 20 MB file under the cap reaches the reader (the old cap rejected anything over 5 MB)', async () => {
    // An image-heavy 20 MB file: read and answered on its merits.
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20 * 1024 * 1024)]);
    const res = await post('upload')
      .attach('file', big, { filename: 'scan.xlsx' })
      .expect(201);
    expect(res.body.triage.kind).toBe('reject');
    expect(res.body.triage.reason).toMatch(/image \(PNG\)/);
  });

  it('Preview accepts a sheet far above Express\'s 100 KB JSON default (was 413)', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => [`Test Person ${i}`, `test${i}@example.com`, '0501234567']);
    const body = { sheet: { name: 'Sheet1', rows }, mapping: { contact: 'Name' }, headerRowIndex: 0 };
    expect(JSON.stringify(body).length).toBeGreaterThan(300 * 1024);
    const res = await post('preview')
      .send(body)
      .expect(201);
    expect(res.body).toEqual({ rows: 6000 });
    expect(parserRan).toHaveBeenCalled();
  });

  describe('the 25 MB JSON body is only parsed for a valid access token (review 2, B4)', () => {
    const body = { sheet: { name: 'Sheet1', rows: [['Name'], ['Test Person 1']] }, mapping: { contact: 'Name' } };

    it.each([
      ['no Authorization header', undefined],
      ['a malformed header', 'Token abc'],
      ['a token signed with another secret', `Bearer ${new JwtService({ secret: 'another-secret-0123456789abcdef0123' }).sign({ sub: 4 })}`],
      ['an expired token', `Bearer ${jwt.sign({ sub: 4, exp: Math.floor(Date.now() / 1000) - 60 })}`],
    ])('%s: 401 with the guard\'s body, parser never runs', async (_label, header) => {
      const req = request(app.getHttpServer()).post('/api/v1/data-import/contacts/preview');
      if (header) req.set('Authorization', header);
      const res = await req.send(body).expect(401);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized', details: null },
      });
      expect(parserRan).not.toHaveBeenCalled();
      expect(previewSheet).not.toHaveBeenCalled();
    });

    it('a valid token: the body is parsed and reaches Preview', async () => {
      const res = await post('preview').send(body).expect(201);
      expect(res.body).toEqual({ rows: 2 });
      expect(parserRan).toHaveBeenCalledTimes(1);
    });

    it('the gate never reads the request body (a 20 MB body stays unread)', () => {
      const gate = contactsImportAuthGate((token) => jwt.verify(token));
      let pulled = 0;
      const reqStream = new Readable({
        read() {
          pulled++;
          this.push(Buffer.alloc(1024 * 1024, 0x20));
        },
      });
      Object.assign(reqStream, { headers: { 'content-type': 'application/json', 'content-length': String(20 * 1024 * 1024) } });
      const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
      const res: any = {
        setHeader: (k: string, v: string) => (sent.headers[k.toLowerCase()] = v),
        status: (code: number) => {
          sent.status = code;
          return res;
        },
        json: (payload: unknown) => {
          sent.body = payload;
          return res;
        },
      };
      const next = jest.fn();
      gate(reqStream as any, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(sent.status).toBe(401);
      expect(sent.headers.connection).toBe('close');
      expect(pulled).toBe(0);
      expect(reqStream.readableFlowing).toBeNull();
    });
  });

  it('Preview refuses a sheet past the cell budget (it could not have come from the upload step)', async () => {
    const res = await post('preview')
      .send({ sheet: { name: 'Sheet1', rows: [Array.from({ length: 201 }, () => 'x')] }, mapping: {} })
      .expect(413);
    expect(res.body.message).toMatch(/past column 200/);
    expect(previewSheet).not.toHaveBeenCalled();
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
    const res = await post('upload')
      .attach('file', csv, { filename: 'contacts.csv' })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/permission/i);
  });

  it('a grant on the parent data-import row is enough; an explicit deny on the child wins', async () => {
    currentUser = PARENT_IMPORTER;
    await post('upload')
      .attach('file', csv, { filename: 'contacts.csv' })
      .expect(201);
    currentUser = CHILD_DENIED;
    await post('upload')
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
  it('uploadProblem: a missing file is a reason, never a 500 (the size cap is Multer\'s 413 now)', () => {
    expect(uploadProblem(undefined)).toMatch(/No file was received/);
    expect(uploadProblem({ buffer: Buffer.alloc(10) })).toBeNull();
  });

  it('the 413 message names the cap in MB and never uses a long dash', () => {
    expect(CONTACTS_FILE_TOO_LARGE_MESSAGE).toBe(
      'The file is larger than 25 MB. Remove images or split the list, then upload again.',
    );
  });

  it('decodeUploadName re-decodes a Latin-1 mangled UTF-8 name and leaves others alone', () => {
    expect(decodeUploadName(Buffer.from('אנשי קשר.xlsx', 'utf8').toString('latin1'))).toBe('אנשי קשר.xlsx');
    expect(decodeUploadName('contacts.xlsx')).toBe('contacts.xlsx');
    expect(decodeUploadName('Café.xlsx')).toBe('Café.xlsx');
    expect(decodeUploadName(undefined)).toBeUndefined();
  });
});
