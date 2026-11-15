/**
 * P1 · Reference model — Phase-2 executor (`POST /admin/backfills/p1-copies-to-refs`).
 *
 * Prisma is an in-memory fake that filters the way the service's
 * queries do and really applies the writes (create / deleteMany, FK
 * cascade of `TemplateTaskDependency`, transaction rollback), so a
 * second run sees what the first one left — no DB needed.
 *
 * The fake is wrapped in a Proxy that THROWS on any model it does not
 * define. Only the five template-side models exist on it, so "never
 * touches Task / TaskDependency / Project*" is not a convention here:
 * any such access fails the spec that made it.
 */
import { BadRequestException, Logger, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { TemplatesService } from '../templates/templates.service';
import { AdminModule } from './admin.module';
import { BackfillsController } from './backfills.controller';
import {
  groupCopyRows,
  resolveDeliverableTemplateByMarker,
  type MarkerCatalogEntry,
} from './p1-copies-to-refs.plan';
import {
  P1CopiesToRefsService,
  parseP1CopiesToRefsBody,
  type P1CopiesToRefsResult,
} from './p1-copies-to-refs.service';

// ─── fixture rows ───────────────────────────────────────────────────

type TemplateFx = {
  id: number;
  name: string;
  type: 'task_list' | 'zone' | 'combined';
  code?: string;
  phaseId?: number | null;
  deletedAt?: Date | null;
};
type RowFx = {
  id: number;
  code: string;
  name?: string;
  description?: string | null;
  phaseId?: number | null;
  serviceTypeId?: number | null;
  deliverableTemplateId?: number | null;
  defaultBudgetHours?: number | Prisma.Decimal | null;
  defaultBudgetAmount?: number | Prisma.Decimal | null;
  sortOrder?: number;
  catalogTaskId?: number | null;
};
type TaskFx = RowFx & { templateId: number };
type ZoneTaskFx = RowFx & { templateZoneId: number };
type ZoneFx = {
  id: number;
  templateId: number;
  name: string;
  parentId?: number | null;
  sortOrder?: number;
  linkedTaskTemplateId?: number | null;
};
type DepFx = { id: number; templateTaskId: number; dependsOnTemplateTaskId: number };

type Fixture = {
  templates: TemplateFx[];
  tasks?: TaskFx[];
  zones?: ZoneFx[];
  zoneTasks?: ZoneTaskFx[];
  deps?: DepFx[];
};

const TEMPLATE_SIDE_MODELS = [
  'template',
  'templateZone',
  'templateTask',
  'templateZoneTask',
  'templateTaskDependency',
];

function makeHarness(fx: Fixture) {
  const row = <T extends RowFx>(r: T) => ({
    name: `Task ${r.code}`,
    description: null,
    phaseId: null,
    serviceTypeId: null,
    deliverableTemplateId: null,
    defaultBudgetHours: null,
    defaultBudgetAmount: null,
    sortOrder: 0,
    catalogTaskId: null,
    ...r,
  });
  const db = {
    templates: fx.templates.map((t) => ({ code: `T${t.id}`, phaseId: null, deletedAt: null, ...t })),
    tasks: (fx.tasks ?? []).map(row),
    zones: (fx.zones ?? []).map((z) => ({ parentId: null, sortOrder: 0, linkedTaskTemplateId: null, ...z })),
    zoneTasks: (fx.zoneTasks ?? []).map(row),
    deps: [...(fx.deps ?? [])],
  };
  type Db = typeof db;
  type TemplateRow = Db['templates'][number];
  type ZoneRow = Db['zones'][number];
  type TemplateWhere = {
    id?: number | { in: number[] };
    code?: string;
    deletedAt?: null;
    type?: string | { not: string };
  };
  type IdsWhere<K extends string> = { id: { in: number[] } } & Record<K, number>;
  type WriteArgs = { data?: Record<string, unknown>; where?: Record<string, unknown> };

  let nextZoneId = 9000;
  const writes: Array<{ model: string; op: string; args: WriteArgs }> = [];
  const touched = new Set<string>();

  const withRelations = (r: Db['tasks'][number] | Db['zoneTasks'][number]) => {
    const catalog = r.catalogTaskId == null ? null : db.tasks.find((t) => t.id === r.catalogTaskId) ?? null;
    return {
      ...r,
      catalogTask: catalog && {
        name: catalog.name,
        defaultBudgetHours: catalog.defaultBudgetHours,
        defaultBudgetAmount: catalog.defaultBudgetAmount,
      },
      predecessors: db.deps
        .filter((d) => d.templateTaskId === r.id)
        .map((d) => ({ dependsOnTemplateTaskId: d.dependsOnTemplateTaskId })),
    };
  };
  const templateOut = (t: TemplateRow) => ({
    ...t,
    templateTasks: db.tasks.filter((x) => x.templateId === t.id).map(withRelations),
    templateZones: db.zones
      .filter((z) => z.templateId === t.id)
      .map((z) => ({
        ...z,
        templateZoneTasks: db.zoneTasks.filter((x) => x.templateZoneId === z.id).map(withRelations),
      })),
  });
  const matches = (t: TemplateRow, where: TemplateWhere = {}): boolean => {
    if (where.id !== undefined) {
      if (typeof where.id === 'number' ? t.id !== where.id : !where.id.in.includes(t.id)) return false;
    }
    if (where.code !== undefined && t.code !== where.code) return false;
    if (where.deletedAt === null && t.deletedAt != null) return false;
    if (where.type !== undefined) {
      if (typeof where.type === 'string' ? t.type !== where.type : t.type === where.type.not) return false;
    }
    return true;
  };

  const models = {
    template: {
      findMany: jest.fn(async ({ where }: { where?: TemplateWhere }) =>
        db.templates
          .filter((t) => matches(t, where))
          .sort((a, b) => a.id - b.id)
          .map(templateOut),
      ),
      findFirst: jest.fn(async ({ where }: { where?: TemplateWhere }) => {
        const hit = db.templates.find((t) => matches(t, where));
        return hit ? templateOut(hit) : null;
      }),
    },
    templateTaskDependency: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { OR: [{ templateTaskId: { in: number[] } }, { dependsOnTemplateTaskId: { in: number[] } }] };
        }) => {
          const a = where.OR[0].templateTaskId.in;
          const b = where.OR[1].dependsOnTemplateTaskId.in;
          return db.deps.filter((d) => a.includes(d.templateTaskId) || b.includes(d.dependsOnTemplateTaskId));
        },
      ),
    },
    templateZone: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { templateId: number; parentId: number | null; linkedTaskTemplateId: number };
        }): Promise<{ id: number } | null> =>
          db.zones.find(
            (z) =>
              z.templateId === where.templateId &&
              z.parentId === where.parentId &&
              z.linkedTaskTemplateId === where.linkedTaskTemplateId,
          ) ?? null,
      ),
      create: jest.fn(async (args: { data: Omit<ZoneRow, 'id'> & Record<string, unknown> }) => {
        writes.push({ model: 'templateZone', op: 'create', args });
        const zone = { ...args.data, id: ++nextZoneId };
        db.zones.push(zone);
        return zone;
      }),
    },
    templateTask: {
      deleteMany: jest.fn(async (args: { where: IdsWhere<'templateId'> }) => {
        writes.push({ model: 'templateTask', op: 'deleteMany', args });
        const ids = args.where.id.in;
        const goneIds = new Set(
          db.tasks.filter((t) => ids.includes(t.id) && t.templateId === args.where.templateId).map((t) => t.id),
        );
        db.tasks = db.tasks.filter((t) => !goneIds.has(t.id));
        // FK cascade from either end.
        db.deps = db.deps.filter(
          (d) => !goneIds.has(d.templateTaskId) && !goneIds.has(d.dependsOnTemplateTaskId),
        );
        return { count: goneIds.size };
      }),
    },
    templateZoneTask: {
      deleteMany: jest.fn(async (args: { where: IdsWhere<'templateZoneId'> }) => {
        writes.push({ model: 'templateZoneTask', op: 'deleteMany', args });
        const ids = args.where.id.in;
        const before = db.zoneTasks.length;
        db.zoneTasks = db.zoneTasks.filter(
          (t) => !(ids.includes(t.id) && t.templateZoneId === args.where.templateZoneId),
        );
        return { count: before - db.zoneTasks.length };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone({ ...db });
      const writesBefore = writes.length;
      try {
        return await fn(prisma);
      } catch (err) {
        Object.assign(db, snapshot); // rollback
        writes.length = writesBefore;
        throw err;
      }
    }),
  };
  const prisma = new Proxy(models, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!prop.startsWith('$')) touched.add(prop);
      if (prop in target) return target[prop as keyof typeof models];
      throw new Error(`prisma.${prop} must never be used by the P1 migration`);
    },
  });
  const asPrismaService = prisma as unknown as PrismaService;

  return {
    prisma,
    asPrismaService,
    db,
    writes,
    touched,
    service: new P1CopiesToRefsService(asPrismaService),
    /** Reach for an arbitrary model name, the way a stray `prisma.task` would. */
    access: (model: string): unknown => (prisma as unknown as Record<string, unknown>)[model],
    creates: () => writes.filter((w) => w.op === 'create').map((w) => w.args.data ?? {}),
    taskIds: () => db.tasks.map((t) => t.id).sort((a, b) => a - b),
    zoneTaskIds: () => db.zoneTasks.map((t) => t.id).sort((a, b) => a - b),
  };
}

const slotOf = (res: P1CopiesToRefsResult, templateId: number, key: string) => {
  const slot = res.templates.find((t) => t.templateId === templateId)?.plannedSlots.find((s) => s.key === key);
  if (!slot) throw new Error(`no planned slot ${key} on template #${templateId}`);
  return slot;
};
const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id).sort((a, b) => a - b);

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════
// The approved planner's rules (work order §0b / §0c). These two pure
// functions are the ones the dry-run script itself now imports.
// ════════════════════════════════════════════════════════════════════
describe('P1 plan — marker resolution and grouping (the approved dry-run rules)', () => {
  const catalog: MarkerCatalogEntry[] = [
    { id: 1, name: 'תיאום ראשוני', phaseId: 10 },
    { id: 2, name: 'תכנון ראשוני\\תשתית ודוח קריטי', phaseId: 10 },
    { id: 3, name: 'מודל\\א', phaseId: 20 },
    { id: 4, name: 'מודל\\ב', phaseId: 30 },
    { id: 5, name: 'פיקוח', phaseId: 40 },
    { id: 6, name: 'פיקוח\\עליון', phaseId: 40 },
  ];

  it('resolves a marker by exact name, then by the base\\detail prefix; a non-marker description resolves to nothing', () => {
    expect(resolveDeliverableTemplateByMarker('[SERVICE:תיאום ראשוני]', null, catalog)).toBe(1);
    expect(resolveDeliverableTemplateByMarker('[SERVICE:תכנון ראשוני]', null, catalog)).toBe(2);
    expect(resolveDeliverableTemplateByMarker('[SERVICE:לא קיים]', null, catalog)).toBeNull();
    // Only a description that IS the marker counts (shared regex).
    expect(resolveDeliverableTemplateByMarker('see [SERVICE:תיאום ראשוני]', null, catalog)).toBeNull();
    expect(resolveDeliverableTemplateByMarker(null, null, catalog)).toBeNull();
  });

  it('several candidates: the phase decides, then exact beats prefix, and it never guesses', () => {
    // Two prefix matches — the task's phase picks one.
    expect(resolveDeliverableTemplateByMarker('[SERVICE:מודל]', 30, catalog)).toBe(4);
    // No phase, no exact match → ambiguous → null.
    expect(resolveDeliverableTemplateByMarker('[SERVICE:מודל]', null, catalog)).toBeNull();
    // A phase that matches neither → still ambiguous.
    expect(resolveDeliverableTemplateByMarker('[SERVICE:מודל]', 99, catalog)).toBeNull();
    // Exact + prefix in the SAME phase → the exact one.
    expect(resolveDeliverableTemplateByMarker('[SERVICE:פיקוח]', 40, catalog)).toBe(5);
    // Exact + prefix, no phase → the single exact one.
    expect(resolveDeliverableTemplateByMarker('[SERVICE:פיקוח]', null, catalog)).toBe(5);
  });

  it('groups by (template, parent zone or root, deliverable); FK first, marker for FK-less rows; own tasks are ignored', () => {
    const r = (id: number, over: Record<string, unknown> = {}) => ({
      id,
      description: null,
      phaseId: null,
      deliverableTemplateId: null,
      ...over,
    });
    const out = groupCopyRows(
      {
        id: 14,
        name: 'Full model',
        templateTasks: [
          r(1, { deliverableTemplateId: 1 }),
          r(2, { deliverableTemplateId: 5 }),
          r(3, { deliverableTemplateId: 1 }),
          r(4, { description: '[SERVICE:תיאום ראשוני]' }), // marker → #1, joins the FK rows
          r(5, { description: '[SERVICE:מודל]' }), // ambiguous → unresolvable
          r(6, { description: 'the template’s own task' }), // ignored
          // The FK wins even when the row also carries a marker for another deliverable.
          r(7, { deliverableTemplateId: 5, description: '[SERVICE:תיאום ראשוני]' }),
        ],
        templateZones: [
          {
            id: 50,
            name: 'Building',
            parentId: null,
            linkedTaskTemplateId: null,
            templateZoneTasks: [r(8, { deliverableTemplateId: 1 }), r(9, { description: '[SERVICE:לא קיים]' })],
          },
        ],
      },
      catalog,
    );

    expect(out.groups.map((g) => [g.key, ids(g.templateTaskRows), ids(g.templateZoneTaskRows), [...g.sources].sort()])).toEqual([
      ['14:root:1', [1, 3, 4], [], ['fk', 'marker']],
      ['14:root:5', [2, 7], [], ['fk']],
      // Same deliverable under a zone is its OWN group — the slot goes under that zone.
      ['14:50:1', [], [8], ['fk']],
    ]);
    expect(out.groups[0].templateTaskRows.map((x) => x.source)).toEqual(['fk', 'fk', 'marker']);
    expect(out.legacyUnresolvable.map((u) => [u.rowKind, u.rowId, u.zoneId])).toEqual([
      ['task', 5, null],
      ['zone_task', 9, 50],
    ]);
    expect([out.fkSourced, out.markerResolved]).toEqual([5, 1]);
  });
});

// ════════════════════════════════════════════════════════════════════
// One composing template, end to end.
//
//   Deliverable #29 "Coordination" (phase 5): A-001, A-002 (← A-001), A-003
//   Deliverable #23 "Model":                  B-001, B-002
//
//   Composing #14 "Full model" [combined]
//     root tasks   101 A-001 · 102 A-002 · 103 A-OLD   (copies of #29)
//                  111 B-001 · 112 B-002              (copies of #23)
//                  120 OWN-1                           (the template's own)
//     zone 50 "Building" (sortOrder 1)
//                  201 B-001                           (copy of #23 under the zone)
// ════════════════════════════════════════════════════════════════════
function fullModelFixture(): Fixture {
  return {
    templates: [
      { id: 14, name: 'Full model', type: 'combined' },
      { id: 29, name: 'Coordination', type: 'task_list', phaseId: 5 },
      { id: 23, name: 'Model', type: 'task_list' },
    ],
    tasks: [
      // Deliverable #29
      { id: 2901, templateId: 29, code: 'A-001', name: 'Kick-off', sortOrder: 1 },
      { id: 2902, templateId: 29, code: 'A-002', name: 'Clash round', sortOrder: 2 },
      { id: 2903, templateId: 29, code: 'A-003', name: 'Sign-off', sortOrder: 3 },
      // Deliverable #23
      { id: 2301, templateId: 23, code: 'B-001', name: 'Model setup', sortOrder: 1 },
      { id: 2302, templateId: 23, code: 'B-002', name: 'Model audit', sortOrder: 2, defaultBudgetHours: 16 },
      // Composing #14 — root copies
      { id: 101, templateId: 14, code: 'A-001', name: 'Kick-off', deliverableTemplateId: 29, phaseId: 5, sortOrder: 1 },
      { id: 102, templateId: 14, code: 'A-002', name: 'Clash round', deliverableTemplateId: 29, phaseId: 5, sortOrder: 2 },
      { id: 103, templateId: 14, code: 'A-OLD', name: 'Retired step', deliverableTemplateId: 29, phaseId: 5, sortOrder: 3 },
      { id: 111, templateId: 14, code: 'B-001', name: 'Model setup', deliverableTemplateId: 23, sortOrder: 4 },
      { id: 112, templateId: 14, code: 'B-002', name: 'Model review', deliverableTemplateId: 23, sortOrder: 5, defaultBudgetHours: 8 },
      { id: 120, templateId: 14, code: 'OWN-1', name: 'Site visit', sortOrder: 6 },
    ],
    zones: [{ id: 50, templateId: 14, name: 'Building', sortOrder: 1 }],
    zoneTasks: [{ id: 201, templateZoneId: 50, code: 'B-001', name: 'Model setup', deliverableTemplateId: 23 }],
    deps: [{ id: 1, templateTaskId: 2902, dependsOnTemplateTaskId: 2901 }],
  };
}

describe('P1CopiesToRefsService — dry-run (the default)', () => {
  it('plans one slot per group, reports the drift, and writes nothing', async () => {
    const h = makeHarness(fullModelFixture());

    const res = await h.service.run({ dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.written).toBeNull();
    expect(res.templates.map((t) => t.templateId)).toEqual([14]);
    const tpl = res.templates[0];
    expect(tpl.written).toBeNull();
    expect(tpl.afterSource).toBe('planned');
    expect(tpl.skippedGroups).toEqual([]);
    expect(tpl.plannedSlots.map((s) => s.key).sort()).toEqual(['14:50:23', '14:root:23', '14:root:29']);

    // ── root → #29: A-OLD is not in the deliverable (kept), A-003 is new.
    const a = slotOf(res, 14, '14:root:29');
    expect(a).toMatchObject({
      parentZoneId: null,
      parentZoneName: null,
      deliverableTemplateId: 29,
      deliverableName: 'Coordination',
      deliverablePhaseId: 5,
      sources: ['fk'],
      deliverableTaskCount: 3,
      deliverableDependencyEdges: 1,
    });
    expect(a.replaces.templateTasks.map((r) => [r.id, r.code])).toEqual([[101, 'A-001'], [102, 'A-002']]);
    expect(a.replaces.templateZoneTasks).toEqual([]);
    expect(a.keeps.map((r) => [r.kind, r.id, r.code])).toEqual([['task', 103, 'A-OLD']]);
    expect(a.drift.onlyInCopy.map((r) => r.code)).toEqual(['A-OLD']);
    expect(a.drift.onlyInDeliverable).toEqual([{ id: 2903, code: 'A-003', name: 'Sign-off' }]);
    expect(a.drift.changed).toEqual([]);
    // The copies store phase 5; the deliverable's tasks store none and
    // take it from the deliverable template (phase 5) at apply — the
    // columns differ, a new project gets the same phase either way.
    expect(a.drift.changedStoredOnly.map((r) => [r.code, r.fields])).toEqual([
      ['A-001', { phaseId: { copy: 5, deliverable: null } }],
      ['A-002', { phaseId: { copy: 5, deliverable: null } }],
    ]);
    expect(a.drift.duplicateCodes).toEqual({ inCopies: [], inDeliverable: [] });

    // ── root → #23: B-002 differs in name and hours; the deliverable wins.
    const b = slotOf(res, 14, '14:root:23');
    expect(ids(b.replaces.templateTasks)).toEqual([111, 112]);
    expect(b.keeps).toEqual([]);
    expect(b.drift.changed).toEqual([
      {
        code: 'B-002',
        copy: { kind: 'task', id: 112 },
        deliverableTaskId: 2302,
        fields: {
          name: { copy: 'Model review', deliverable: 'Model audit' },
          defaultBudgetHours: { copy: 8, deliverable: 16 },
        },
      },
    ]);

    // ── zone 50 → #23: a CHILD slot of the zone the copy sits in (§0b.1).
    const c = slotOf(res, 14, '14:50:23');
    expect(c).toMatchObject({ parentZoneId: 50, parentZoneName: 'Building' });
    expect(c.slot.parentId).toBe(50);
    expect(c.replaces.templateZoneTasks.map((r) => [r.id, r.code])).toEqual([[201, 'B-001']]);
    expect(c.drift.onlyInDeliverable.map((t) => t.code)).toEqual(['B-002']);

    expect(res.totals).toMatchObject({
      templates: 1,
      slots: 3,
      copyRowsDeleted: 5, // 101, 102, 111, 112, 201
      copyRowsKept: 1, // 103
      legacyUnresolvable: 0,
      skippedGroups: 0,
      drift: { onlyInCopy: 1, onlyInDeliverable: 2, changed: 1, changedStoredOnly: 2 },
      fkSourcedRows: 6,
      markerResolvedRows: 0,
      projectsTouched: 0,
    });

    // Nothing was written and no transaction was opened.
    expect(h.writes).toEqual([]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.taskIds()).toEqual([101, 102, 103, 111, 112, 120, 2301, 2302, 2901, 2902, 2903]);
    expect(h.zoneTaskIds()).toEqual([201]);
  });

  it('BEFORE shows the copies; AFTER shows the slots with what they pull, the kept copy flagged, own tasks untouched', async () => {
    const h = makeHarness(fullModelFixture());
    const { templates } = await h.service.run({ dryRun: true });
    const { before, after } = templates[0];

    expect(before).toEqual([
      'Template #14 "Full model" [combined]',
      '├── Task A-001 "Kick-off" (dt=29)',
      '├── Task A-002 "Clash round" (dt=29)',
      '├── Task A-OLD "Retired step" (dt=29)',
      '├── Task B-001 "Model setup" (dt=23)',
      '├── Task B-002 "Model review" (dt=23)',
      '├── Task OWN-1 "Site visit"',
      '└── Zone "Building" (#50) [sortOrder 1]',
      '    └── Task B-001 "Model setup" (dt=23)',
    ]);
    expect(after).toEqual([
      'Template #14 "Full model" [combined]',
      '├── Task A-OLD "Retired step" (dt=29)  ← KEPT: code not in the deliverable',
      '├── Task OWN-1 "Site visit"',
      '├── Zone "Building" (#50) [sortOrder 1]',
      '│   └── Slot "Model" (NEW, linked→#23) [sortOrder 1] · 2 tasks, 0 dependency edges',
      '│       ├── · B-001 "Model setup"  (from the deliverable)',
      '│       └── · B-002 "Model audit"  (from the deliverable)',
      '├── Slot "Coordination" (NEW, linked→#29) [sortOrder 2] · 3 tasks, 1 dependency edges',
      '│   ├── · A-001 "Kick-off"  (from the deliverable)',
      '│   ├── · A-002 "Clash round"  (from the deliverable)',
      '│   └── · A-003 "Sign-off"  (from the deliverable)',
      '└── Slot "Model" (NEW, linked→#23) [sortOrder 4] · 2 tasks, 0 dependency edges',
      '    ├── · B-001 "Model setup"  (from the deliverable)',
      '    └── · B-002 "Model audit"  (from the deliverable)',
    ]);
  });

  it('only an explicit dryRun:false is a real run; a malformed templateIds is a 400, never "all templates"', () => {
    for (const body of [undefined, null, {}, { dryRun: true }, { dryRun: 'false' }, { dryRun: 0 }, { dryRun: null }, 'false']) {
      expect(parseP1CopiesToRefsBody(body).dryRun).toBe(true);
    }
    expect(parseP1CopiesToRefsBody({ dryRun: false })).toEqual({ dryRun: false });
    expect(parseP1CopiesToRefsBody({ dryRun: false, templateIds: [42, 14, 42] })).toEqual({
      dryRun: false,
      templateIds: [42, 14],
    });
    expect(parseP1CopiesToRefsBody({ templateIds: null })).toEqual({ dryRun: true });

    for (const templateIds of ['42', 42, [], ['42'], [1.5], [0], [-3], [42, null], { 0: 42 }]) {
      expect(() => parseP1CopiesToRefsBody({ dryRun: false, templateIds })).toThrow(BadRequestException);
    }
  });
});

describe('P1CopiesToRefsService — real run', () => {
  it('creates the slots and deletes only the copies they replace — in one transaction for the template', async () => {
    const h = makeHarness(fullModelFixture());

    const res = await h.service.run({ dryRun: false, actorId: 7 });

    expect(res.dryRun).toBe(false);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);

    // Three slots, exactly as planned.
    expect(h.creates()).toEqual([
      {
        templateId: 14,
        parentId: 50,
        zoneType: 'building',
        name: 'Model',
        code: null,
        isTypical: false,
        typicalCount: 1,
        instanceCount: 1,
        sortOrder: 1,
        linkedTaskTemplateId: 23,
        referencedTemplateId: null,
      },
      expect.objectContaining({ parentId: null, name: 'Coordination', sortOrder: 2, linkedTaskTemplateId: 29 }),
      expect.objectContaining({ parentId: null, name: 'Model', sortOrder: 4, linkedTaskTemplateId: 23 }),
    ]);

    // Matched copies are gone; the kept copy, the template's own task
    // and every deliverable task are still there.
    expect(h.taskIds()).toEqual([103, 120, 2301, 2302, 2901, 2902, 2903]);
    expect(h.zoneTaskIds()).toEqual([]);
    // The kept copy is still tagged with its deliverable.
    expect(h.db.tasks.find((t) => t.id === 103)).toMatchObject({ code: 'A-OLD', deliverableTemplateId: 29 });
    // The deliverable's own dependency edge is untouched.
    expect(h.db.deps).toEqual([{ id: 1, templateTaskId: 2902, dependsOnTemplateTaskId: 2901 }]);

    // Every delete is pinned to the template / the zone it belongs to.
    const deletes = h.writes.filter((w) => w.op === 'deleteMany');
    expect(deletes.map((w) => [w.model, w.args.where])).toEqual([
      ['templateZoneTask', { id: { in: [201] }, templateZoneId: 50 }],
      ['templateTask', { id: { in: [101, 102] }, templateId: 14 }],
      ['templateTask', { id: { in: [111, 112] }, templateId: 14 }],
    ]);

    // What was written is reported, per template and in total.
    const tpl = res.templates[0];
    expect(tpl.written).toMatchObject({
      status: 'written',
      templateTasksDeleted: 4,
      templateZoneTasksDeleted: 1,
      error: null,
    });
    expect(tpl.written!.slotsCreated.map((s) => [s.key, s.parentZoneId, s.deliverableTemplateId, s.sortOrder])).toEqual([
      ['14:50:23', 50, 23, 1],
      ['14:root:29', null, 29, 2],
      ['14:root:23', null, 23, 4],
    ]);
    expect(res.written).toEqual({
      templates: 1,
      slotsCreated: 3,
      templateTasksDeleted: 4,
      templateZoneTasksDeleted: 1,
      copyRowsDeleted: 5,
      failedTemplateId: null,
      notAttemptedTemplateIds: [],
      projectsTouched: 0,
    });
    // The drift report is in the real response too.
    expect(slotOf(res, 14, '14:root:29').drift.onlyInCopy.map((r) => r.code)).toEqual(['A-OLD']);

    // AFTER is re-read from the database and names the zones created.
    const [slot50, slot29, slot23] = tpl.written!.slotsCreated.map((s) => s.zoneId);
    expect(tpl.afterSource).toBe('actual');
    expect(tpl.after).toEqual([
      'Template #14 "Full model" [combined]',
      '├── Task A-OLD "Retired step" (dt=29)  ← KEPT: code not in the deliverable',
      '├── Task OWN-1 "Site visit"',
      '├── Zone "Building" (#50) [sortOrder 1]',
      `│   └── Slot "Model" (NEW #${slot50}, linked→#23) [sortOrder 1] · 2 tasks, 0 dependency edges`,
      '│       ├── · B-001 "Model setup"  (from the deliverable)',
      '│       └── · B-002 "Model audit"  (from the deliverable)',
      `├── Slot "Coordination" (NEW #${slot29}, linked→#29) [sortOrder 2] · 3 tasks, 1 dependency edges`,
      '│   ├── · A-001 "Kick-off"  (from the deliverable)',
      '│   ├── · A-002 "Clash round"  (from the deliverable)',
      '│   └── · A-003 "Sign-off"  (from the deliverable)',
      `└── Slot "Model" (NEW #${slot23}, linked→#23) [sortOrder 4] · 2 tasks, 0 dependency edges`,
      '    ├── · B-001 "Model setup"  (from the deliverable)',
      '    └── · B-002 "Model audit"  (from the deliverable)',
    ]);
  });

  it('the slot is field for field the row the compose UI writes (TemplatesService.addDeliverableRef)', async () => {
    const h = makeHarness(fullModelFixture());
    await h.service.run({ dryRun: false });
    const [childSlot, rootSlot] = h.creates();

    // The same two slots through the compose path, with the sortOrder the migration chose.
    const viaComposeUi = async (parentZoneId: number | null, deliverable: { id: number; name: string }, sortOrder: number) => {
      const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }));
      const prisma = {
        template: { findFirst: jest.fn().mockResolvedValue({ ...deliverable, code: 'D', type: 'task_list' }) },
        templateZone: {
          findUnique: jest.fn().mockResolvedValue({ id: parentZoneId, templateId: 14 }),
          aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 99 } }),
          create,
        },
      };
      const templates = new TemplatesService(prisma as unknown as PrismaService);
      jest.spyOn(templates, 'findOne').mockResolvedValue({} as never);
      await templates.addDeliverableRef(14, { deliverableTemplateId: deliverable.id, parentZoneId, sortOrder });
      return create.mock.calls[0][0].data;
    };

    expect(rootSlot).toEqual(await viaComposeUi(null, { id: 29, name: 'Coordination' }, 2));
    expect(childSlot).toEqual(await viaComposeUi(50, { id: 23, name: 'Model' }, 1));
  });

  it('is idempotent: a second run plans nothing, writes nothing, and reports the leftover copy as already linked', async () => {
    const h = makeHarness(fullModelFixture());
    await h.service.run({ dryRun: false });
    const writesAfterFirst = h.writes.length;
    const tasksAfterFirst = h.taskIds();

    const second = await h.service.run({ dryRun: false });

    expect(second.totals).toMatchObject({ templates: 0, slots: 0, copyRowsDeleted: 0, skippedGroups: 1 });
    expect(second.totals.skippedGroupsByReason.already_linked).toBe(1);
    expect(second.written).toMatchObject({ templates: 0, slotsCreated: 0, copyRowsDeleted: 0, failedTemplateId: null });
    // The copy the first run kept (A-OLD) still forms a group — recognised by the slot, left alone.
    const tpl = second.templates[0];
    expect(tpl.plannedSlots).toEqual([]);
    expect(tpl.written!.status).toBe('nothing_to_write');
    expect(tpl.skippedGroups.map((g) => [g.key, g.reason, ids(g.copyRows)])).toEqual([
      ['14:root:29', 'already_linked', [103]],
    ]);

    expect(h.writes).toHaveLength(writesAfterFirst);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1); // the first run's only
    expect(h.taskIds()).toEqual(tasksAfterFirst);

    // A dry-run after the migration agrees.
    const dry = await h.service.run({ dryRun: true });
    expect(dry.totals.slots).toBe(0);
  });

  it('never touches a project-side model — dry-run or real run', async () => {
    const h = makeHarness(fullModelFixture());

    await h.service.run({ dryRun: true });
    await h.service.run({ dryRun: false });
    await h.service.run({ dryRun: false });

    // Every model the service reached for, over three runs.
    expect([...h.touched].sort()).toEqual([...TEMPLATE_SIDE_MODELS].sort());
    // …and the fake really does refuse everything else, so the line above is not vacuous.
    for (const model of ['task', 'taskDependency', 'project', 'projectDeliverable', 'zone', 'zoneDeliverableTarget', 'taskAssignee']) {
      expect(() => h.access(model)).toThrow(/must never be used/);
    }
    // The response says so as well.
    const res = await h.service.run({ dryRun: true });
    expect(res.totals.projectsTouched).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// Groups that are NOT converted.
// ════════════════════════════════════════════════════════════════════
describe('P1CopiesToRefsService — skipped groups', () => {
  const composing: TemplateFx = { id: 8, name: 'Composing', type: 'zone' };
  const copy = (id: number, code: string, deliverableTemplateId: number, over: Partial<TaskFx> = {}): TaskFx => ({
    id,
    templateId: 8,
    code,
    deliverableTemplateId,
    ...over,
  });
  const dtask = (id: number, templateId: number, code: string, over: Partial<TaskFx> = {}): TaskFx => ({
    id,
    templateId,
    code,
    ...over,
  });

  async function runBoth(fx: Fixture) {
    const h = makeHarness(fx);
    const dry = await h.service.run({ dryRun: true });
    const real = await h.service.run({ dryRun: false });
    return { h, dry, real };
  }

  it('a duplicated code — in the copies or in the deliverable — skips the whole group and names the codes', async () => {
    const { h, dry, real } = await runBoth({
      templates: [
        composing,
        { id: 41, name: 'Dup in copies', type: 'task_list' },
        { id: 42, name: 'Dup in deliverable', type: 'task_list' },
        { id: 43, name: 'Clean', type: 'task_list' },
      ],
      tasks: [
        dtask(4101, 41, 'X-1'),
        dtask(4102, 41, 'X-2'),
        dtask(4201, 42, 'Y-1'),
        dtask(4202, 42, 'Y-1'),
        dtask(4301, 43, 'Z-1'),
        copy(1, 'X-1', 41),
        copy(2, 'X-1', 41), // the same code twice in the copies
        copy(3, 'X-2', 41),
        copy(4, 'Y-1', 42),
        copy(5, 'Z-1', 43),
      ],
    });

    for (const res of [dry, real]) {
      const tpl = res.templates[0];
      expect(tpl.skippedGroups.map((g) => [g.key, g.reason, g.drift!.duplicateCodes])).toEqual([
        ['8:root:41', 'duplicate_codes', { inCopies: ['X-1'], inDeliverable: [] }],
        ['8:root:42', 'duplicate_codes', { inCopies: [], inDeliverable: ['Y-1'] }],
      ]);
      expect(tpl.skippedGroups[0].copyRows.map((r) => r.id)).toEqual([1, 2, 3]);
      // The clean group next to them is still converted.
      expect(tpl.plannedSlots.map((s) => s.key)).toEqual(['8:root:43']);
      expect(res.totals.skippedGroupsByReason.duplicate_codes).toBe(2);
    }
    // Real run: only the clean group was written; every row of the skipped groups survives.
    expect(h.creates().map((d) => d.linkedTaskTemplateId)).toEqual([43]);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([1, 2, 3, 4]);
  });

  it('a deliverable that is missing, soft-deleted, or not a task_list skips the group', async () => {
    const { h, dry, real } = await runBoth({
      templates: [
        composing,
        { id: 51, name: 'Deleted deliverable', type: 'task_list', deletedAt: new Date('2026-11-01T00:00:00Z') },
        { id: 52, name: 'A zone template', type: 'zone' },
      ],
      tasks: [
        dtask(5101, 51, 'D-1'),
        copy(1, 'D-1', 51),
        copy(2, 'E-1', 52),
        copy(3, 'F-1', 999), // points at a template that does not exist
      ],
    });

    for (const res of [dry, real]) {
      const tpl = res.templates.find((t) => t.templateId === 8)!;
      expect(tpl.plannedSlots).toEqual([]);
      expect(tpl.skippedGroups.map((g) => [g.key, g.reason, g.deliverableName, g.drift])).toEqual([
        ['8:root:51', 'deliverable_deleted', 'Deleted deliverable', null],
        ['8:root:52', 'deliverable_not_task_list', 'A zone template', null],
        ['8:root:999', 'deliverable_missing', null, null],
      ]);
    }
    expect(h.writes).toEqual([]);
    expect(real.templates.find((t) => t.templateId === 8)!.written!.status).toBe('nothing_to_write');
    expect(h.taskIds().filter((id) => id < 100)).toEqual([1, 2, 3]);
  });

  it('already linked (the approved idempotence rule): a zone at the same parent links the deliverable → nothing is created, copies stay', async () => {
    const { h, real } = await runBoth({
      templates: [composing, { id: 61, name: 'Linked', type: 'task_list' }],
      tasks: [dtask(6101, 61, 'L-1'), copy(1, 'L-1', 61)],
      zones: [
        { id: 70, templateId: 8, name: 'Linked', sortOrder: 1, linkedTaskTemplateId: 61 }, // slot at the ROOT
        { id: 71, templateId: 8, name: 'Building', sortOrder: 2 },
      ],
      // The same deliverable copied under zone 71 is a different parent → still converted.
      zoneTasks: [{ id: 9, templateZoneId: 71, code: 'L-1', deliverableTemplateId: 61 }],
    });

    const tpl = real.templates[0];
    expect(tpl.skippedGroups.map((g) => [g.key, g.reason])).toEqual([['8:root:61', 'already_linked']]);
    expect(tpl.plannedSlots.map((s) => s.key)).toEqual(['8:71:61']);
    expect(h.creates().map((d) => [d.parentId, d.linkedTaskTemplateId])).toEqual([[71, 61]]);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([1]); // the root copy is left alone
    expect(h.zoneTaskIds()).toEqual([]);
  });

  it('no code in common with the deliverable → no slot (it would replace nothing and only add tasks)', async () => {
    const { h, dry } = await runBoth({
      templates: [composing, { id: 62, name: 'Recoded', type: 'task_list' }],
      tasks: [dtask(6201, 62, 'NEW-1'), dtask(6202, 62, 'NEW-2'), copy(1, 'OLD-1', 62), copy(2, '', 62)],
    });

    const group = dry.templates[0].skippedGroups[0];
    expect(group).toMatchObject({ key: '8:root:62', reason: 'no_matching_codes' });
    // A blank code cannot be matched — it is listed with the other unmatched copies.
    expect(group.drift!.onlyInCopy.map((r) => [r.id, r.code])).toEqual([[1, 'OLD-1'], [2, '']]);
    expect(group.drift!.onlyInDeliverable.map((t) => t.code)).toEqual(['NEW-1', 'NEW-2']);
    expect(h.writes).toEqual([]);
  });

  it('a slot is not planted deeper than apply loads slots: copies under a depth-2 zone stay', async () => {
    const { h, dry } = await runBoth({
      templates: [composing, { id: 63, name: 'Deep', type: 'task_list' }],
      tasks: [dtask(6301, 63, 'P-1')],
      zones: [
        { id: 80, templateId: 8, name: 'Building', sortOrder: 1 },
        { id: 81, templateId: 8, name: 'Level', parentId: 80, sortOrder: 1 },
      ],
      zoneTasks: [
        { id: 1, templateZoneId: 80, code: 'P-1', deliverableTemplateId: 63 }, // under a root zone → fine
        { id: 2, templateZoneId: 81, code: 'P-1', deliverableTemplateId: 63 }, // under a depth-2 zone → skipped
      ],
    });

    const tpl = dry.templates[0];
    expect(tpl.plannedSlots.map((s) => s.key)).toEqual(['8:80:63']);
    expect(tpl.skippedGroups.map((g) => [g.key, g.reason])).toEqual([['8:81:63', 'parent_zone_too_deep']]);
    expect(h.zoneTaskIds()).toEqual([2]);
  });

  it('legacy [SERVICE:] rows: a resolvable marker is converted like an FK row, an unresolvable one is only listed', async () => {
    const { h, dry } = await runBoth({
      templates: [composing, { id: 64, name: 'Supervision', type: 'task_list' }],
      tasks: [
        dtask(6401, 64, 'S-1'),
        copy(1, 'S-1', null as unknown as number, { description: '[SERVICE:Supervision]' }),
        copy(2, 'Q-1', null as unknown as number, { description: '[SERVICE:Gone]' }),
      ],
    });

    const tpl = dry.templates[0];
    expect(tpl.plannedSlots.map((s) => [s.key, s.sources, ids(s.replaces.templateTasks)])).toEqual([
      ['8:root:64', ['marker'], [1]],
    ]);
    expect(tpl.legacyUnresolvable).toEqual([
      {
        templateId: 8,
        templateName: 'Composing',
        rowId: 2,
        rowKind: 'task',
        description: '[SERVICE:Gone]',
        phaseId: null,
        zoneId: null,
        zoneName: null,
      },
    ]);
    expect(dry.totals).toMatchObject({ legacyUnresolvable: 1, markerResolvedRows: 1, fkSourcedRows: 0 });
    expect(h.taskIds().filter((id) => id < 100)).toEqual([2]); // the unresolvable row is never deleted
  });
});

// ════════════════════════════════════════════════════════════════════
// Drift details, slot order, the filter, failure handling.
// ════════════════════════════════════════════════════════════════════
describe('P1CopiesToRefsService — drift report', () => {
  it('`changed` compares what apply writes; stored-only differences are listed apart', async () => {
    const h = makeHarness({
      templates: [
        { id: 8, name: 'Composing', type: 'zone' },
        { id: 70, name: 'Deliverable', type: 'task_list', phaseId: 5 },
        { id: 1, name: 'Task Catalog', type: 'task_list', code: '__TASK_CATALOG__' },
      ],
      tasks: [
        // Task Catalog rows
        { id: 900, templateId: 1, code: 'CAT-1', name: 'Live catalog name', defaultBudgetHours: 12 },
        { id: 901, templateId: 1, code: 'C-4', name: 'Code fallback', defaultBudgetHours: 6 },
        // Deliverable #70 (template phase 5 wins over each task's own phase)
        { id: 7001, templateId: 70, code: 'C-1', name: 'Stale deliverable snapshot', catalogTaskId: 900 },
        { id: 7002, templateId: 70, code: 'C-2', name: 'Same', phaseId: null, serviceTypeId: 3 },
        { id: 7003, templateId: 70, code: 'C-3', name: 'Same', defaultBudgetHours: new Prisma.Decimal('8') },
        { id: 7004, templateId: 70, code: 'C-4', name: 'Same', defaultBudgetHours: 6 },
        { id: 7005, templateId: 70, code: 'C-5', name: 'Same', phaseId: 5 },
        // Copies in #8
        // C-1: both link the same catalog task → same live name/hours; the stored names differ only.
        { id: 1, templateId: 8, code: 'C-1', name: 'Stale copy snapshot', deliverableTemplateId: 70, phaseId: 5, catalogTaskId: 900 },
        // C-2: phase 5 on the copy = the deliverable template's phase; serviceType really differs.
        { id: 2, templateId: 8, code: 'C-2', name: 'Same', deliverableTemplateId: 70, phaseId: 5, serviceTypeId: 4 },
        // C-3: Decimal('8.00') vs Decimal('8') is the same number.
        { id: 3, templateId: 8, code: 'C-3', name: 'Same', deliverableTemplateId: 70, phaseId: 5, defaultBudgetHours: new Prisma.Decimal('8.00') },
        // C-4: no hours on the copy → apply falls back to the Task Catalog entry with the same code (6) = the deliverable's 6.
        { id: 4, templateId: 8, code: 'C-4', name: 'Same', deliverableTemplateId: 70, phaseId: 5 },
        // C-5: the copy sits in phase 9; new projects will get the deliverable's phase 5.
        { id: 5, templateId: 8, code: 'C-5', name: 'Same', deliverableTemplateId: 70, phaseId: 9 },
      ],
    });

    const res = await h.service.run({ dryRun: true, templateIds: [8] });
    const { drift } = slotOf(res, 8, '8:root:70');

    expect(drift.changed).toEqual([
      { code: 'C-2', copy: { kind: 'task', id: 2 }, deliverableTaskId: 7002, fields: { serviceTypeId: { copy: 4, deliverable: 3 } } },
      { code: 'C-5', copy: { kind: 'task', id: 5 }, deliverableTaskId: 7005, fields: { phaseId: { copy: 9, deliverable: 5 } } },
    ]);
    expect(drift.changedStoredOnly).toEqual([
      {
        code: 'C-1',
        copy: { kind: 'task', id: 1 },
        deliverableTaskId: 7001,
        fields: {
          name: { copy: 'Stale copy snapshot', deliverable: 'Stale deliverable snapshot' },
          phaseId: { copy: 5, deliverable: null },
        },
      },
      { code: 'C-2', copy: { kind: 'task', id: 2 }, deliverableTaskId: 7002, fields: { phaseId: { copy: 5, deliverable: null } } },
      { code: 'C-3', copy: { kind: 'task', id: 3 }, deliverableTaskId: 7003, fields: { phaseId: { copy: 5, deliverable: null } } },
      {
        code: 'C-4',
        copy: { kind: 'task', id: 4 },
        deliverableTaskId: 7004,
        fields: { defaultBudgetHours: { copy: null, deliverable: 6 }, phaseId: { copy: 5, deliverable: null } },
      },
    ]);
    expect(drift.onlyInCopy).toEqual([]);
    expect(drift.onlyInDeliverable).toEqual([]);
    expect(res.totals.drift).toEqual({ onlyInCopy: 0, onlyInDeliverable: 0, changed: 2, changedStoredOnly: 4 });
  });

  it('reports the dependency rows that go with the deleted copies, and which of them the deliverable does not define', async () => {
    const h = makeHarness({
      templates: [
        { id: 8, name: 'Composing', type: 'zone' },
        { id: 70, name: 'Deliverable', type: 'task_list' },
      ],
      tasks: [
        { id: 7001, templateId: 70, code: 'C-1' },
        { id: 7002, templateId: 70, code: 'C-2' },
        { id: 7003, templateId: 70, code: 'C-3' },
        { id: 1, templateId: 8, code: 'C-1', deliverableTemplateId: 70 },
        { id: 2, templateId: 8, code: 'C-2', deliverableTemplateId: 70 },
        { id: 3, templateId: 8, code: 'C-3', deliverableTemplateId: 70 },
        { id: 9, templateId: 8, code: 'OWN-1' },
      ],
      deps: [
        { id: 100, templateTaskId: 7002, dependsOnTemplateTaskId: 7001 }, // the deliverable: C-2 ← C-1
        { id: 201, templateTaskId: 2, dependsOnTemplateTaskId: 1 }, // copies: C-2 ← C-1 — the deliverable has it
        { id: 202, templateTaskId: 3, dependsOnTemplateTaskId: 2 }, // copies: C-3 ← C-2 — only on the copies
        { id: 203, templateTaskId: 9, dependsOnTemplateTaskId: 3 }, // own task ← copy C-3 — only on the copies
      ],
    });

    const dry = await h.service.run({ dryRun: true });
    const slot = slotOf(dry, 8, '8:root:70');
    expect(slot.deliverableDependencyEdges).toBe(1);
    expect(slot.copyDependencyEdges).toEqual({
      cascaded: 3,
      notInDeliverable: [
        { id: 202, taskId: 3, taskCode: 'C-3', dependsOnId: 2, dependsOnCode: 'C-2' },
        { id: 203, taskId: 9, taskCode: 'OWN-1', dependsOnId: 3, dependsOnCode: 'C-3' },
      ],
    });
    expect(dry.totals).toMatchObject({ copyDependencyEdgesCascaded: 3, copyDependencyEdgesNotInDeliverable: 2 });

    // The real run deletes the copies; their edges cascade, the deliverable's stays.
    await h.service.run({ dryRun: false });
    expect(h.db.deps).toEqual([{ id: 100, templateTaskId: 7002, dependsOnTemplateTaskId: 7001 }]);
  });
});

describe('P1CopiesToRefsService — slot sortOrder', () => {
  const deliverables = (...list: number[]): Pick<Fixture, 'templates' | 'tasks'> => ({
    templates: [
      { id: 8, name: 'Composing', type: 'zone' },
      ...list.map((id) => ({ id, name: `D${id}`, type: 'task_list' as const })),
    ],
    tasks: list.map((id) => ({ id: id * 100, templateId: id, code: `K${id}` })),
  });
  const orders = (res: P1CopiesToRefsResult) =>
    res.templates[0].plannedSlots.map((s) => [s.deliverableTemplateId, s.slot.sortOrder, s.sortOrderBasis.adjusted]);

  it('a slot takes the smallest sortOrder among its copies — the order the deliverables appear in today', async () => {
    const base = deliverables(31, 32, 33);
    const h = makeHarness({
      ...base,
      tasks: [
        ...base.tasks!,
        // Interleaved on purpose: #33 appears first (3), then #31 (5), then #32 (9).
        { id: 1, templateId: 8, code: 'K31', deliverableTemplateId: 31, sortOrder: 7 },
        { id: 2, templateId: 8, code: 'K32', deliverableTemplateId: 32, sortOrder: 9 },
        { id: 3, templateId: 8, code: 'K33', deliverableTemplateId: 33, sortOrder: 3 },
        { id: 4, templateId: 8, code: 'K31-b', deliverableTemplateId: 31, sortOrder: 5 },
      ],
    });

    const res = await h.service.run({ dryRun: true });

    expect(orders(res)).toEqual([
      [33, 3, false],
      [31, 5, false],
      [32, 9, false],
    ]);
    expect(res.templates[0].plannedSlots[1].sortOrderBasis).toEqual({
      smallestCopySortOrder: 5,
      adjusted: false,
      note: null,
    });
  });

  it('ties and taken numbers: row id breaks a tie, never below 1, never the number of a sibling zone or of the previous slot', async () => {
    const base = deliverables(31, 32, 33);
    const h = makeHarness({
      ...base,
      tasks: [
        ...base.tasks!,
        // Never ordered: every copy carries sortOrder 0. Row ids give the order 32, 31, 33.
        { id: 1, templateId: 8, code: 'K32', deliverableTemplateId: 32 },
        { id: 2, templateId: 8, code: 'K31', deliverableTemplateId: 31 },
        { id: 3, templateId: 8, code: 'K33', deliverableTemplateId: 33 },
      ],
      // Sibling zones at the root already hold 1 and 3.
      zones: [
        { id: 60, templateId: 8, name: 'Building A', sortOrder: 1 },
        { id: 61, templateId: 8, name: 'Building B', sortOrder: 3 },
      ],
    });

    const res = await h.service.run({ dryRun: true });

    // wanted max(1, 0) = 1 → taken by zone 60 → 2; next: > 2 and free → 4 (3 is zone 61); next → 5.
    expect(orders(res)).toEqual([
      [32, 2, true],
      [31, 4, true],
      [33, 5, true],
    ]);
    expect(res.templates[0].plannedSlots[0].sortOrderBasis.smallestCopySortOrder).toBe(0);
    expect(res.templates[0].plannedSlots[0].sortOrderBasis.note).toMatch(/taken/);
  });

  it('a lone unordered group is raised from 0 to 1 and says why', async () => {
    const base = deliverables(31);
    const h = makeHarness({
      ...base,
      tasks: [...base.tasks!, { id: 1, templateId: 8, code: 'K31', deliverableTemplateId: 31 }],
    });
    const res = await h.service.run({ dryRun: true });

    expect(orders(res)).toEqual([[31, 1, true]]);
    expect(res.templates[0].plannedSlots[0].sortOrderBasis.note).toMatch(/Raised to 1/);
  });
});

describe('P1CopiesToRefsService — templateIds filter and failures', () => {
  // Three composing templates, each with one copy of deliverable #90.
  const threeTemplates = (): Fixture => ({
    templates: [
      { id: 11, name: 'First', type: 'zone' },
      { id: 16, name: 'Second', type: 'combined' },
      { id: 30, name: 'Third', type: 'zone' },
      { id: 90, name: 'Deliverable', type: 'task_list' },
      { id: 91, name: 'Removed composing', type: 'zone', deletedAt: new Date('2026-11-01T00:00:00Z') },
    ],
    tasks: [
      { id: 9001, templateId: 90, code: 'R-1' },
      { id: 1, templateId: 11, code: 'R-1', deliverableTemplateId: 90 },
      { id: 2, templateId: 16, code: 'R-1', deliverableTemplateId: 90 },
      { id: 3, templateId: 30, code: 'R-1', deliverableTemplateId: 90 },
      { id: 4, templateId: 91, code: 'R-1', deliverableTemplateId: 90 },
    ],
  });

  it('templateIds limits the run to those composing templates and reports ids that are not one', async () => {
    const h = makeHarness(threeTemplates());

    // 90 is a deliverable, 91 is soft-deleted, 777 does not exist.
    const res = await h.service.run({ dryRun: false, templateIds: [16, 90, 91, 777] });

    expect(res.requestedTemplateIds).toEqual([16, 90, 91, 777]);
    expect(res.unknownTemplateIds).toEqual([90, 91, 777]);
    expect(res.scannedTemplates).toBe(1);
    expect(res.templates.map((t) => t.templateId)).toEqual([16]);
    expect(res.written).toMatchObject({ templates: 1, slotsCreated: 1, copyRowsDeleted: 1 });
    // Only template 16 was converted.
    expect(h.creates().map((d) => d.templateId)).toEqual([16]);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([1, 3, 4]);

    // Without a filter the rest follow — one transaction each — and 16 is not converted twice.
    const rest = await h.service.run({ dryRun: false });
    expect(rest.requestedTemplateIds).toBeNull();
    expect(rest.written).toMatchObject({ templates: 2, slotsCreated: 2 });
    expect(h.creates().map((d) => d.templateId)).toEqual([16, 11, 30]);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([4]); // the soft-deleted template is out of scope
  });

  it('a requested template with nothing to convert is still reported — explicitly empty', async () => {
    const h = makeHarness(threeTemplates());
    await h.service.run({ dryRun: false, templateIds: [16] });

    const again = await h.service.run({ dryRun: true, templateIds: [16] });

    expect(again.templates).toHaveLength(1);
    expect(again.templates[0]).toMatchObject({ templateId: 16, plannedSlots: [], skippedGroups: [], legacyUnresolvable: [] });
    expect(again.totals).toMatchObject({ templates: 0, slots: 0, copyRowsDeleted: 0 });
    // Unfiltered, a template with nothing to report is left out.
    const all = await h.service.run({ dryRun: true });
    expect(all.templates.map((t) => t.templateId)).toEqual([11, 30]);
  });

  it('a failing template rolls back whole, and the run stops there — later templates are not attempted', async () => {
    const h = makeHarness(threeTemplates());
    // The second template's copy disappears between the plan and its delete.
    const realDelete = h.prisma.templateTask.deleteMany.getMockImplementation()!;
    h.prisma.templateTask.deleteMany.mockImplementation(async (args) =>
      args.where.templateId === 16 ? { count: 0 } : realDelete(args),
    );

    const res = await h.service.run({ dryRun: false });

    expect(res.templates.map((t) => [t.templateId, t.written!.status])).toEqual([
      [11, 'written'],
      [16, 'failed'],
      [30, 'not_attempted'],
    ]);
    expect(res.templates[1].written!.error).toMatch(/expected to delete 1 TemplateTask copies.*matched 0/);
    expect(res.templates[1].afterSource).toBe('planned');
    expect(res.written).toMatchObject({
      templates: 1,
      slotsCreated: 1,
      copyRowsDeleted: 1,
      failedTemplateId: 16,
      notAttemptedTemplateIds: [30],
    });
    // Template 11 is converted; 16 has neither a slot nor a missing row; 30 is untouched.
    expect(h.db.zones.map((z) => z.templateId)).toEqual([11]);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([2, 3, 4]);
  });

  it('a committed template is reported as written even when re-reading it for the AFTER tree fails', async () => {
    const h = makeHarness(threeTemplates());
    const realFindFirst = h.prisma.template.findFirst.getMockImplementation()!;
    // Only the post-write re-read asks for a template by bare id.
    h.prisma.template.findFirst.mockImplementation(async (args) => {
      if (args.where?.id !== undefined && args.where.type === undefined) throw new Error('connection lost');
      return realFindFirst(args);
    });

    const res = await h.service.run({ dryRun: false, templateIds: [11] });

    expect(res.templates[0].written).toMatchObject({ status: 'written', templateTasksDeleted: 1, error: null });
    expect(res.templates[0].afterSource).toBe('planned'); // the planned tree stays in the response
    expect(res.written).toMatchObject({ templates: 1, failedTemplateId: null });
    expect(h.db.zones.map((z) => z.templateId)).toEqual([11]);
  });

  it('the endpoint: admin:write on POST admin/backfills/p1-copies-to-refs, dry-run unless the body says dryRun:false', async () => {
    const handler = BackfillsController.prototype.runP1CopiesToRefs;
    // Same guard metadata as every other backfill in the controller.
    expect(Reflect.getMetadata(PATH_METADATA, BackfillsController)).toBe('admin/backfills');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('p1-copies-to-refs');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([{ module: 'admin', action: 'write' }]);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(
      Reflect.getMetadata(ROLES_KEY, BackfillsController.prototype.runRelinkTemplateDeliverables),
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, BackfillsController)).toEqual([JwtAuthGuard, RolesGuard]);
    // …and the service is registered where the controller lives.
    expect(Reflect.getMetadata('providers', AdminModule)).toContain(P1CopiesToRefsService);

    const h = makeHarness(threeTemplates());
    const run = jest.spyOn(h.service, 'run');
    const controller = new BackfillsController(h.asPrismaService, {} as never, {} as never, h.service);
    const admin = { id: 7 };

    // No body at all → a dry-run of everything.
    const dry = await controller.runP1CopiesToRefs(admin, undefined);
    expect(run).toHaveBeenLastCalledWith({ dryRun: true, templateIds: undefined, actorId: 7 });
    expect(dry.dryRun).toBe(true);
    expect(h.writes).toEqual([]);

    // The explicit switch, limited to one template.
    const real = await controller.runP1CopiesToRefs(admin, { dryRun: false, templateIds: [16] });
    expect(run).toHaveBeenLastCalledWith({ dryRun: false, templateIds: [16], actorId: 7 });
    expect(real.written).toMatchObject({ templates: 1, slotsCreated: 1 });

    // A malformed filter never reaches the service.
    run.mockClear();
    await expect(
      controller.runP1CopiesToRefs(admin, { dryRun: false, templateIds: '16' as unknown as number[] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(run).not.toHaveBeenCalled();
  });

  it('a slot that appeared after the plan was computed aborts the template instead of creating a second one', async () => {
    const h = makeHarness(threeTemplates());
    // Another request converts template 11 while this one is between plan and write.
    h.prisma.templateZone.findFirst.mockResolvedValueOnce({ id: 4242 });

    const res = await h.service.run({ dryRun: false, templateIds: [11] });

    expect(res.templates[0].written).toMatchObject({ status: 'failed', slotsCreated: [] });
    expect(res.templates[0].written!.error).toMatch(/zone #4242 already links deliverable #90/);
    expect(h.writes).toEqual([]);
    expect(h.taskIds().filter((id) => id < 100)).toEqual([1, 2, 3, 4]);
  });
});
