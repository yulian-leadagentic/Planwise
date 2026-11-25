/**
 * PR-053 (QA6, 2026-11-25) — archive templates instead of deleting them.
 *
 * Acceptance:
 *   • a template in use can be archived, and restored;
 *   • an archived template is gone from every list / picker (the default
 *     `GET /templates`), for Deliverable (`task_list`) and hierarchical
 *     Zone (`zone`) templates alike, and can't be picked into another
 *     template; it stays readable by id where it is already used;
 *   • delete works only for an unused template; an in-use one gets a 409
 *     TEMPLATE_IN_USE instead.
 *
 * In-memory Prisma fake: only the calls these paths make.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { TemplatesController } from './templates.controller';
import {
  TemplatesService,
  describeTemplateUsage,
  parseArchivedFilter,
  type TemplateUsage,
} from './templates.service';

interface Tpl {
  id: number;
  code: string;
  name: string;
  type: 'task_list' | 'zone' | 'combined';
  usageCount: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
}
interface State {
  templates: Tpl[];
  projectDeliverables: Array<{ sourceTemplateId: number; deletedAt: Date | null }>;
  tasks: Array<{ deliverableTemplateId: number; deletedAt: Date | null }>;
  templateZones: Array<{
    id: number;
    templateId: number;
    linkedTaskTemplateId: number | null;
    referencedTemplateId: number | null;
  }>;
  templateZoneTasks: Array<{ deliverableTemplateId: number; templateZoneId: number }>;
}

function tpl(id: number, type: Tpl['type'], extra: Partial<Tpl> = {}): Tpl {
  return {
    id,
    code: `T${id}`,
    name: `Template ${id}`,
    type,
    usageCount: 0,
    archivedAt: null,
    deletedAt: null,
    ...extra,
  };
}

function makePrisma(state: State) {
  const liveOwner = (templateId: number) =>
    state.templates.some((t) => t.id === templateId && t.deletedAt == null);
  const groupCount = <T extends Record<string, any>>(rows: T[], key: keyof T, ids: number[]) => {
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (r.deletedAt != null || !ids.includes(r[key])) continue;
      counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
    }
    return [...counts].map(([id, n]) => ({ [key]: id, _count: { _all: n } }));
  };
  const asListRow = (t: Tpl) => ({
    ...t,
    phase: null,
    creator: null,
    templateTasks: [],
    templateZones: [],
    _count: { templateTasks: 0, templateZones: 0 },
  });
  const prisma: any = {
    template: {
      findMany: jest.fn(async ({ where }: any) =>
        state.templates
          .filter((t) => t.deletedAt == null && (!where?.type || t.type === where.type))
          .map(asListRow),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const t = state.templates.find(
          (x) => x.id === where.id && (where.deletedAt !== null || x.deletedAt == null),
        );
        return t ? asListRow(t) : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = state.templates.find((x) => x.id === where.id)!;
        Object.assign(t, data);
        return { id: t.id, archivedAt: t.archivedAt };
      }),
    },
    projectDeliverable: {
      groupBy: jest.fn(async ({ where }: any) =>
        groupCount(state.projectDeliverables, 'sourceTemplateId', where.sourceTemplateId.in),
      ),
    },
    task: {
      groupBy: jest.fn(async ({ where }: any) =>
        groupCount(state.tasks, 'deliverableTemplateId', where.deliverableTemplateId.in),
      ),
    },
    templateZone: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: number[] = where.OR[0].linkedTaskTemplateId.in;
        return state.templateZones
          .filter(
            (z) =>
              (ids.includes(z.linkedTaskTemplateId as number) ||
                ids.includes(z.referencedTemplateId as number)) &&
              liveOwner(z.templateId),
          )
          .map((z) => ({
            templateId: z.templateId,
            linkedTaskTemplateId: z.linkedTaskTemplateId,
            referencedTemplateId: z.referencedTemplateId,
          }));
      }),
      findUnique: jest.fn(async ({ where }: any) => state.templateZones.find((z) => z.id === where.id) ?? null),
      count: jest.fn(async () => 0),
      aggregate: jest.fn(async () => ({ _max: { sortOrder: 0 } })),
      create: jest.fn(async ({ data }: any) => ({ id: 999, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    templateZoneTask: {
      findMany: jest.fn(async ({ where }: any) => {
        const ids: number[] = where.deliverableTemplateId.in;
        return state.templateZoneTasks
          .map((zt) => ({ zt, zone: state.templateZones.find((z) => z.id === zt.templateZoneId)! }))
          .filter(({ zt, zone }) => ids.includes(zt.deliverableTemplateId) && liveOwner(zone.templateId))
          .map(({ zt, zone }) => ({
            deliverableTemplateId: zt.deliverableTemplateId,
            templateZone: { templateId: zone.templateId },
          }));
      }),
    },
  };
  return prisma;
}

/**
 * 1 Task Catalog · 10 deliverable, in use (applied + a project task) ·
 * 11 deliverable, referenced only by zone template 20 · 12 deliverable,
 * unused · 13 deliverable, already archived · 20 zone template, links 11
 * and has a zone task of 12's sibling 14 · 21 zone template, referenced
 * by 20 · 22 zone template, unused · 14 deliverable, used by a zone
 * task in 20 · 30 deleted zone template that linked 12 (doesn't count).
 */
function seed(): State {
  return {
    templates: [
      tpl(1, 'task_list', { code: '__TASK_CATALOG__', name: 'Task Catalog' }),
      tpl(10, 'task_list', { usageCount: 2 }),
      tpl(11, 'task_list'),
      tpl(12, 'task_list'),
      tpl(13, 'task_list', { archivedAt: new Date('2026-11-01T00:00:00Z') }),
      tpl(14, 'task_list'),
      tpl(20, 'zone'),
      tpl(21, 'zone'),
      tpl(22, 'zone'),
      tpl(30, 'zone', { deletedAt: new Date('2026-10-01T00:00:00Z') }),
    ],
    projectDeliverables: [
      { sourceTemplateId: 10, deletedAt: null },
      { sourceTemplateId: 12, deletedAt: new Date() }, // deleted, doesn't count
    ],
    tasks: [
      { deliverableTemplateId: 10, deletedAt: null },
      { deliverableTemplateId: 10, deletedAt: null },
      { deliverableTemplateId: 12, deletedAt: new Date() },
    ],
    templateZones: [
      { id: 500, templateId: 20, linkedTaskTemplateId: 11, referencedTemplateId: null },
      { id: 501, templateId: 20, linkedTaskTemplateId: null, referencedTemplateId: 21 },
      { id: 502, templateId: 20, linkedTaskTemplateId: 11, referencedTemplateId: null },
      { id: 503, templateId: 30, linkedTaskTemplateId: 12, referencedTemplateId: null },
      { id: 504, templateId: 22, linkedTaskTemplateId: null, referencedTemplateId: 22 }, // self
    ],
    templateZoneTasks: [{ deliverableTemplateId: 14, templateZoneId: 501 }],
  };
}

function service(state = seed()) {
  const prisma = makePrisma(state);
  return { svc: new TemplatesService(prisma), prisma, state };
}

const ids = (rows: any[]) => rows.map((r) => r.id).sort((a, b) => a - b);

describe('PR-053 · usage ("in use")', () => {
  it('counts applies, live project deliverables / tasks and distinct other live templates', async () => {
    const { svc, state } = service();
    const usage = await svc.getUsage(state.templates.filter((t) => t.deletedAt == null));
    expect(usage.get(10)).toEqual({
      applied: 2,
      projectDeliverables: 1,
      projectTasks: 2,
      composingTemplates: 0,
      inUse: true,
    });
    // Two slots in the same composing template = one composing template.
    expect(usage.get(11)).toMatchObject({ composingTemplates: 1, inUse: true });
    expect(usage.get(14)).toMatchObject({ composingTemplates: 1, inUse: true });
    expect(usage.get(21)).toMatchObject({ composingTemplates: 1, inUse: true });
    // Deleted deliverable / task / composing template and a
    // self-reference don't make a template "in use".
    expect(usage.get(12)).toMatchObject({ inUse: false });
    expect(usage.get(22)).toMatchObject({ inUse: false });
  });

  it('describes the usage in plain words (no long dashes)', () => {
    const u: TemplateUsage = {
      applied: 1,
      projectDeliverables: 2,
      projectTasks: 1,
      composingTemplates: 3,
      inUse: true,
    };
    const text = describeTemplateUsage(u);
    expect(text).toBe('applied 1 time, 2 project deliverables, 1 project task, used by 3 other templates');
    expect(text).not.toMatch(/[–—]/);
  });
});

describe('PR-053 · archive and restore', () => {
  it('archives a template that is in use, then restores it', async () => {
    const { svc, state } = service();
    const archived = await svc.archive(10);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(state.templates.find((t) => t.id === 10)!.archivedAt).toBeInstanceOf(Date);
    // Nothing else about the template changed (still used, not deleted).
    expect(state.templates.find((t) => t.id === 10)).toMatchObject({ usageCount: 2, deletedAt: null });

    const restored = await svc.restore(10);
    expect(restored.archivedAt).toBeNull();
    expect(state.templates.find((t) => t.id === 10)!.archivedAt).toBeNull();
  });

  it('archives a hierarchical Zone template the same way', async () => {
    const { svc, state } = service();
    await svc.archive(21);
    expect(state.templates.find((t) => t.id === 21)!.archivedAt).toBeInstanceOf(Date);
  });

  it('is idempotent both ways', async () => {
    const { svc, prisma } = service();
    const first = await svc.archive(13); // already archived
    expect(first.archivedAt).toEqual(new Date('2026-11-01T00:00:00Z'));
    await svc.restore(12); // already active
    expect(prisma.template.update).not.toHaveBeenCalled();
  });

  it('refuses the Task Catalog with TEMPLATE_CATALOG_NOT_ARCHIVABLE', async () => {
    const { svc } = service();
    const err = await svc.archive(1).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_CATALOG_NOT_ARCHIVABLE' });
  });

  it('404s on a missing or deleted template', async () => {
    const { svc } = service();
    await expect(svc.archive(404)).rejects.toThrow(NotFoundException);
    await expect(svc.restore(30)).rejects.toThrow(NotFoundException);
  });
});

describe('PR-053 · archived templates are hidden from pickers', () => {
  it('the default list (every picker) leaves archived Deliverable templates out', async () => {
    const { svc } = service();
    await svc.archive(10);
    const rows = await svc.findAll('task_list');
    expect(ids(rows)).toEqual([1, 11, 12, 14]);
  });

  it('the default list leaves archived Zone templates out', async () => {
    const { svc } = service();
    await svc.archive(21);
    expect(ids(await svc.findAll('zone'))).toEqual([20, 22]);
    expect(ids(await svc.findAll())).not.toContain(21);
  });

  it('archived=only is the Archived view; archived=include returns both', async () => {
    const { svc } = service();
    await svc.archive(21);
    expect(ids(await svc.findAll('task_list', 'only'))).toEqual([13]);
    expect(ids(await svc.findAll('zone', 'only'))).toEqual([21]);
    expect(ids(await svc.findAll('zone', 'include'))).toEqual([20, 21, 22]);
  });

  it('every row carries archivedAt and usage', async () => {
    const { svc } = service();
    const rows = await svc.findAll('task_list', 'include');
    const r10 = rows.find((r: any) => r.id === 10)!;
    const r13 = rows.find((r: any) => r.id === 13)!;
    expect(r10.usage).toMatchObject({ inUse: true, applied: 2 });
    expect(r10.archivedAt).toBeNull();
    expect(r13.archivedAt).toEqual(new Date('2026-11-01T00:00:00Z'));
  });

  it('an archived template stays readable by id (projects / templates that use it)', async () => {
    const { svc, prisma } = service();
    await svc.archive(10);
    const t = await svc.findOne(10);
    expect(t.id).toBe(10);
    expect(prisma.template.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 10, deletedAt: null } }),
    );
  });

  it('an archived deliverable cannot be added as a new slot (TEMPLATE_ARCHIVED)', async () => {
    const { svc, prisma } = service();
    const err = await svc.addDeliverableRef(20, { deliverableTemplateId: 13 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
    expect(prisma.templateZone.create).not.toHaveBeenCalled();
  });

  it('an archived zone template cannot be referenced by a new zone (TEMPLATE_ARCHIVED)', async () => {
    const { svc, prisma } = service();
    await svc.archive(22);
    const err = await svc
      .addZone(20, { name: 'Ref', zoneType: 'building', referencedTemplateId: 22 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
    expect(prisma.templateZone.create).not.toHaveBeenCalled();
  });

  it('an existing reference to a since-archived template is untouched by a zone edit', async () => {
    const { svc, prisma } = service();
    await svc.archive(21);
    // Zone 501 already references 21; re-sending the same id is fine.
    await svc.updateZone(501, { name: 'Renamed', referencedTemplateId: 21 });
    expect(prisma.templateZone.update).toHaveBeenCalled();
    // Re-pointing to an archived template is refused.
    await svc.archive(22);
    await expect(svc.updateZone(501, { referencedTemplateId: 22 })).rejects.toThrow(ConflictException);
  });

  it('rejects an unknown archived filter with TEMPLATES_ARCHIVED_FILTER_INVALID', () => {
    expect(parseArchivedFilter(undefined)).toBe('exclude');
    expect(parseArchivedFilter('only')).toBe('only');
    const err = (() => {
      try {
        parseArchivedFilter('yes');
      } catch (e) {
        return e as BadRequestException;
      }
    })();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.getResponse()).toMatchObject({ code: 'TEMPLATES_ARCHIVED_FILTER_INVALID' });
  });
});

describe('PR-053 · delete only an unused template', () => {
  it('rejects deleting an in-use Deliverable template with 409 TEMPLATE_IN_USE', async () => {
    const { svc, state } = service();
    const err = await svc.remove(10).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: 'TEMPLATE_IN_USE',
      details: { templateId: 10, applied: 2, projectDeliverables: 1, projectTasks: 2, inUse: true },
    });
    expect(err.getResponse().message).toContain('Archive it instead');
    expect(state.templates.find((t) => t.id === 10)!.deletedAt).toBeNull();
  });

  it('rejects deleting a template another template references (never applied)', async () => {
    const { svc } = service();
    const err = await svc.remove(11).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'TEMPLATE_IN_USE', details: { composingTemplates: 1 } });
    const zoneErr = await svc.remove(21).catch((e) => e);
    expect(zoneErr.getResponse()).toMatchObject({ code: 'TEMPLATE_IN_USE' });
  });

  it('rejects deleting an archived template that is still in use', async () => {
    const { svc } = service();
    await svc.archive(10);
    await expect(svc.remove(10)).rejects.toThrow(ConflictException);
  });

  it('deletes an unused template (soft delete)', async () => {
    const { svc, state } = service();
    await expect(svc.remove(12)).resolves.toEqual({ message: 'Template deleted' });
    expect(state.templates.find((t) => t.id === 12)!.deletedAt).toBeInstanceOf(Date);
    await expect(svc.remove(22)).resolves.toEqual({ message: 'Template deleted' });
  });
});

describe('PR-053 · controller', () => {
  const perm = (route: string, flags: Record<string, boolean>) => ({
    module: { route, name: route.slice(1) },
    ...flags,
  });
  const EDITOR = {
    id: 4,
    isAdmin: false,
    roleModules: [perm('/templates', { canRead: true, canWrite: true })],
  };
  const MANAGER = {
    id: 5,
    isAdmin: false,
    roleModules: [perm('/templates', { canRead: true, canWrite: true, canDelete: true })],
  };
  function make() {
    const templatesService: any = {
      findOne: jest.fn(async (id: number) => ({ id, type: 'zone' })),
      findAll: jest.fn(async () => []),
      archive: jest.fn(async (id: number) => ({ id, archivedAt: new Date() })),
      restore: jest.fn(async (id: number) => ({ id, archivedAt: null })),
    };
    return { ctrl: new TemplatesController(templatesService), templatesService };
  }

  it('archive / restore need the template kind\'s delete right', async () => {
    const { ctrl, templatesService } = make();
    await expect(ctrl.archive(EDITOR, 21)).rejects.toThrow(ForbiddenException);
    await expect(ctrl.restore(EDITOR, 21)).rejects.toThrow(ForbiddenException);
    expect(templatesService.archive).not.toHaveBeenCalled();
    await ctrl.archive(MANAGER, 21);
    await ctrl.restore(MANAGER, 21);
    expect(templatesService.archive).toHaveBeenCalledWith(21);
    expect(templatesService.restore).toHaveBeenCalledWith(21);
  });

  it('GET /templates passes the archived filter through, default exclude', async () => {
    const { ctrl, templatesService } = make();
    await ctrl.findAll(MANAGER, 'zone');
    await ctrl.findAll(MANAGER, 'zone', 'only');
    expect(templatesService.findAll).toHaveBeenNthCalledWith(1, 'zone', 'exclude');
    expect(templatesService.findAll).toHaveBeenNthCalledWith(2, 'zone', 'only');
    expect(() => ctrl.findAll(MANAGER, 'zone', 'nope')).toThrow(BadRequestException);
  });
});
