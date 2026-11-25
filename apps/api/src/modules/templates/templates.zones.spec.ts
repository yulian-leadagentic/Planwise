/**
 * QA6 (2026-11-25) — `POST /templates/45/zones` answered 500 on 22.11 at
 * 08:27 ("Unhandled error"). Staging log (Railway, read-only):
 *
 *   Invalid `this.prisma.templateZone.create()` invocation
 *     data: { templateId: 45, parentId: null, zoneType: "zone", name: "Basment", ... }
 *   Invalid value for argument `zoneType`. Expected ZoneType.
 *
 * The Zone Template editor's "Add Zone (choose type)" form starts on the
 * legacy code 'zone'; `template_zones.zone_type` only holds site /
 * building / level / wing. These specs reproduce that request and the
 * other inputs that could reach Prisma unchecked, and pin the 4xx codes
 * that replace the 500.
 */
import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { TemplatesService, mapTemplateZoneWriteError } from './templates.service';

interface Zone {
  id: number;
  templateId: number;
  parentId: number | null;
  referencedTemplateId: number | null;
  linkedTaskTemplateId: number | null;
  name: string;
  zoneType: string;
}

const ZONE_TYPES = ['site', 'building', 'level', 'wing'];

function makePrisma() {
  const templates = [
    { id: 45, type: 'zone', name: 'Building A', archivedAt: null, deletedAt: null },
    { id: 46, type: 'zone', name: 'Other zone template', archivedAt: null, deletedAt: null },
    { id: 47, type: 'zone', name: 'Floor', archivedAt: null, deletedAt: null },
    { id: 48, type: 'zone', name: 'Wing set', archivedAt: null, deletedAt: null },
    { id: 60, type: 'task_list', name: 'BIM Coordination', archivedAt: null, deletedAt: null },
  ];
  const zones: Zone[] = [
    { id: 900, templateId: 45, parentId: null, referencedTemplateId: null, linkedTaskTemplateId: null, name: 'Root', zoneType: 'building' },
    { id: 901, templateId: 46, parentId: null, referencedTemplateId: null, linkedTaskTemplateId: null, name: 'Elsewhere', zoneType: 'site' },
    // 47 → 48 → 45: referencing 47 from 45 would close a cycle.
    { id: 902, templateId: 47, parentId: null, referencedTemplateId: 48, linkedTaskTemplateId: null, name: 'Ref 48', zoneType: 'level' },
    { id: 903, templateId: 48, parentId: null, referencedTemplateId: 45, linkedTaskTemplateId: null, name: 'Ref 45', zoneType: 'wing' },
  ];
  let nextId = 1000;
  const prisma: any = {
    template: {
      findFirst: jest.fn(async ({ where }: any) => {
        const t = templates.find((x) => x.id === where.id && x.deletedAt == null);
        if (!t) return null;
        return { ...t, code: `T${t.id}`, templateTasks: [], templateZones: [] };
      }),
    },
    templateZone: {
      count: jest.fn(async () => 0),
      aggregate: jest.fn(async () => ({ _max: { sortOrder: 3 } })),
      findUnique: jest.fn(async ({ where }: any) => zones.find((z) => z.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        zones
          .filter((z) => where.templateId.in.includes(z.templateId) && z.referencedTemplateId != null)
          .map((z) => ({ referencedTemplateId: z.referencedTemplateId })),
      ),
      // Behaves like Prisma on the enum column: anything else is a
      // PrismaClientValidationError (the 22.11 500).
      create: jest.fn(async ({ data }: any) => {
        if (!ZONE_TYPES.includes(data.zoneType)) {
          throw new Prisma.PrismaClientValidationError(
            'Invalid value for argument `zoneType`. Expected ZoneType.',
            { clientVersion: '5.22.0' },
          );
        }
        const row = { id: nextId++, ...data };
        zones.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const z = zones.find((x) => x.id === where.id)!;
        if (data.zoneType !== undefined && !ZONE_TYPES.includes(data.zoneType)) {
          throw new Prisma.PrismaClientValidationError('Invalid value for argument `zoneType`.', {
            clientVersion: '5.22.0',
          });
        }
        for (const [k, v] of Object.entries(data)) if (v !== undefined) (z as any)[k] = v;
        return z;
      }),
      delete: jest.fn(async () => ({})),
    },
  };
  return { prisma, zones };
}

function make() {
  const { prisma, zones } = makePrisma();
  return { svc: new TemplatesService(prisma), prisma, zones };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const err: any = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e) => e,
  );
  return { status: err.getStatus?.() ?? 500, code: err.getResponse?.()?.code ?? err.message };
}

/** What the client would get for an error, through the real global filter. */
function viaFilter(err: unknown): { status: number; code: string } {
  let status = 0;
  let body: any;
  const res = {
    status: (s: number) => {
      status = s;
      return res;
    },
    json: (b: any) => {
      body = b;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', url: '/api/v1/templates/45/zones' }),
    }),
  } as unknown as ArgumentsHost;
  const filter = new HttpExceptionFilter();
  (filter as any).logger = { error: jest.fn(), warn: jest.fn() };
  filter.catch(err, host);
  return { status, code: body.error.code };
}

describe('QA6 · POST /templates/:id/zones — the 22.11 500', () => {
  it('reproduction: the raw Prisma error for zoneType "zone" is a 500 through the filter', () => {
    const raw = new Prisma.PrismaClientValidationError('Invalid value for argument `zoneType`.', {
      clientVersion: '5.22.0',
    });
    expect(viaFilter(raw)).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('the same request now succeeds: legacy "zone" is saved as a Building zone', async () => {
    const { svc, prisma } = make();
    const zone: any = await svc.addZone(45, { name: 'Basment', zoneType: 'zone' });
    expect(zone).toMatchObject({ templateId: 45, name: 'Basment', zoneType: 'building', parentId: null, sortOrder: 4 });
    expect(prisma.templateZone.create).toHaveBeenCalledTimes(1);
  });

  it('every legacy code maps like POST /zones (ZT-3), case and spaces ignored', async () => {
    const { svc } = make();
    const types: string[] = [];
    for (const zt of ['floor', 'AREA', ' section ', 'Level', 'wing']) {
      types.push(((await svc.addZone(45, { name: `Z ${zt}`, zoneType: zt })) as any).zoneType);
    }
    expect(types).toEqual(['level', 'site', 'wing', 'level', 'wing']);
  });

  it('a missing zoneType falls back to building (column default)', async () => {
    const { svc } = make();
    expect(((await svc.addZone(45, { name: 'No type' })) as any).zoneType).toBe('building');
  });

  it('an unknown zoneType is a 400 TEMPLATE_ZONE_TYPE_INVALID naming the allowed values', async () => {
    const { svc, prisma } = make();
    const err: any = await svc.addZone(45, { name: 'Tower', zoneType: 'tower' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: 'TEMPLATE_ZONE_TYPE_INVALID',
      details: { allowed: ['site', 'building', 'level', 'wing'] },
    });
    expect(viaFilter(err)).toEqual({ status: 400, code: 'TEMPLATE_ZONE_TYPE_INVALID' });
    expect(prisma.templateZone.create).not.toHaveBeenCalled();
  });
});

describe('QA6 · POST /templates/:id/zones — other inputs that reached Prisma unchecked', () => {
  it('name is required and at most 255 characters; code at most 50', async () => {
    const { svc } = make();
    expect(await codeOf(svc.addZone(45, { zoneType: 'site' }))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_NAME_REQUIRED' });
    expect(await codeOf(svc.addZone(45, { name: '   ' }))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_NAME_REQUIRED' });
    expect(await codeOf(svc.addZone(45, { name: 'x'.repeat(256) }))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_NAME_TOO_LONG' });
    expect(await codeOf(svc.addZone(45, { name: 'ok', code: 'c'.repeat(51) }))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_CODE_TOO_LONG' });
  });

  it('the parent must be a zone of the same template', async () => {
    const { svc } = make();
    // Parent of another template (was silently accepted).
    expect(await codeOf(svc.addZone(45, { name: 'Child', parentId: 901 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_PARENT_MISMATCH',
    });
    // Missing parent (was a foreign-key 500).
    expect(await codeOf(svc.addZone(45, { name: 'Child', parentId: 123456 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_PARENT_MISMATCH',
    });
    expect(await codeOf(svc.addZone(45, { name: 'Child', parentId: 'abc' }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_PARENT_INVALID',
    });
    const child: any = await svc.addZone(45, { name: 'Child', parentId: 900, zoneType: 'level' });
    expect(child).toMatchObject({ parentId: 900, zoneType: 'level' });
  });

  it('references: not itself, must exist, no cycle; a slot must be a Deliverable template', async () => {
    const { svc } = make();
    expect(await codeOf(svc.addZone(45, { name: 'Self', referencedTemplateId: 45 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_SELF_REFERENCE',
    });
    expect(await codeOf(svc.addZone(45, { name: 'Missing', referencedTemplateId: 999 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_REF_NOT_FOUND',
    });
    // 47 → 48 → 45: 45 → 47 would loop.
    expect(await codeOf(svc.addZone(45, { name: 'Loop', referencedTemplateId: 47 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_REFERENCE_CYCLE',
    });
    expect(await codeOf(svc.addZone(45, { name: 'Bad slot', linkedTaskTemplateId: 46 }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_LINK_WRONG_TYPE',
    });
    // Valid ones go through.
    await expect(svc.addZone(46, { name: 'Ref 47', referencedTemplateId: 47, zoneType: 'level' })).resolves.toMatchObject({
      referencedTemplateId: 47,
    });
    await expect(svc.addZone(45, { name: 'Slot', linkedTaskTemplateId: 60 })).resolves.toMatchObject({
      linkedTaskTemplateId: 60,
    });
  });

  it('numbers: sortOrder / typicalCount must be whole numbers (strings used to reach Prisma)', async () => {
    const { svc } = make();
    expect(await codeOf(svc.addZone(45, { name: 'Z', sortOrder: 'first' }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_SORT_ORDER_INVALID',
    });
    expect(await codeOf(svc.addZone(45, { name: 'Z', typicalCount: 'many' }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_COUNT_INVALID',
    });
    const z: any = await svc.addZone(45, { name: 'Z', sortOrder: '7', typicalCount: '3', instanceCount: 'x', isTypical: 'true' });
    expect(z).toMatchObject({ sortOrder: 7, typicalCount: 3, instanceCount: 1, isTypical: true });
  });

  it('a duplicate name / code in the same template is allowed (no unique constraint on template_zones)', async () => {
    const { svc, zones } = make();
    await svc.addZone(45, { name: 'Basement', code: 'B1' });
    await svc.addZone(45, { name: 'Basement', code: 'B1' });
    expect(zones.filter((z) => z.templateId === 45 && z.name === 'Basement')).toHaveLength(2);
  });

  it('an unknown template is a 404, not a 500', async () => {
    const { svc } = make();
    await expect(svc.addZone(4040, { name: 'Z' })).rejects.toThrow(NotFoundException);
  });

  it('a Prisma error that still gets through is a 4xx with a code', () => {
    const validation = new Prisma.PrismaClientValidationError('bad', { clientVersion: '5.22.0' });
    const fk = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: '5.22.0' });
    const tooLong = new Prisma.PrismaClientKnownRequestError('long', { code: 'P2000', clientVersion: '5.22.0' });
    const missing = new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: '5.22.0' });
    expect(viaFilter(mapTemplateZoneWriteError(validation))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_INVALID' });
    expect(viaFilter(mapTemplateZoneWriteError(fk))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_REFERENCE_INVALID' });
    expect(viaFilter(mapTemplateZoneWriteError(tooLong))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_VALUE_TOO_LONG' });
    expect(viaFilter(mapTemplateZoneWriteError(missing))).toEqual({ status: 404, code: 'NOT_FOUND' });
    const other = new Error('boom');
    expect(mapTemplateZoneWriteError(other)).toBe(other);
  });
});

describe('QA6 · PATCH / DELETE /templates/zones/:id', () => {
  it('the inline type select posting legacy "zone" saves building; unknown is a 400', async () => {
    const { svc, zones } = make();
    await svc.updateZone(900, { zoneType: 'zone' });
    expect(zones.find((z) => z.id === 900)!.zoneType).toBe('building');
    expect(await codeOf(svc.updateZone(900, { zoneType: 'tower' }))).toEqual({
      status: 400,
      code: 'TEMPLATE_ZONE_TYPE_INVALID',
    });
  });

  it('only the sent fields are validated and written', async () => {
    const { svc, prisma } = make();
    await svc.updateZone(900, { instanceCount: 4 });
    const data = prisma.templateZone.update.mock.calls[0][0].data;
    expect(data.instanceCount).toBe(4);
    expect(data.name).toBeUndefined();
    expect(data.zoneType).toBeUndefined();
    expect(await codeOf(svc.updateZone(900, { name: '' }))).toEqual({ status: 400, code: 'TEMPLATE_ZONE_NAME_REQUIRED' });
  });

  it('a missing zone is a 404 (was a Prisma P2025 500) on update and delete', async () => {
    const { svc } = make();
    await expect(svc.updateZone(4040, { name: 'x' })).rejects.toThrow(NotFoundException);
    await expect(svc.removeZone(4040)).rejects.toThrow(NotFoundException);
    await expect(svc.removeZone(900)).resolves.toEqual({ message: 'Template zone deleted' });
  });
});
