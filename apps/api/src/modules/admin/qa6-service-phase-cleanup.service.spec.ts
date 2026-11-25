/**
 * PR-069 (QA6, 2026-11-25) — Service vs project phase cleanup.
 *
 * The `phases` table is the "Service" catalog; the v8 seed also put the
 * project lifecycle phases in it, and it carries a duplicate service.
 * Acceptance:
 *   • the dry-run (default) lists every candidate with id, name, code,
 *     kind guess, usage counts and the proposed action, and writes nothing;
 *   • a real run needs `approved: [{ id, action, mergeInto? }]` and acts
 *     only on those rows; when the recomputed plan of an approved row is
 *     not what was approved (action or merge target), 409 and nothing is
 *     written (security review 25.11);
 *   • nothing a task points at breaks: merge re-points, nothing is deleted;
 *   • `/phases?scope=services` (and the web pickers) leave phases out even
 *     before the cleanup runs.
 */
import { BadRequestException, ConflictException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PhasesController } from '../phases/phases.controller';
import { PhasesService } from '../phases/phases.service';
import { isPickableService, isProjectPhaseName, PROJECT_PHASE_NAMES } from '../phases/service-phase-rule';
import { AdminModule } from './admin.module';
import { BackfillsController } from './backfills.controller';
import { EMPTY_USAGE, type PhaseRow, type PhaseUsage, planServicePhaseCleanup } from './qa6-service-phase-cleanup.plan';
import {
  Qa6ServicePhaseCleanupService,
  parseServicePhaseCleanupBody,
} from './qa6-service-phase-cleanup.service';

const row = (id: number, name: string, extra: Partial<PhaseRow> = {}): PhaseRow => ({
  id,
  name,
  code: null,
  kind: 'service',
  isActive: true,
  ...extra,
});

/** The staging shape QA6 reported, plus a few controls. */
function stagingLikeRows(): PhaseRow[] {
  return [
    row(1, 'Pre-Design'),
    row(2, 'Design'),
    row(3, 'Construction'),
    row(4, 'AFC'),
    row(5, 'Handover'),
    row(6, 'Maintenance'),
    row(7, 'תכנון מפורט'),
    row(8, 'תכנון סופי'),
    row(9, 'תכנון לביצוע'),
    row(10, 'BIM Coordination', { code: 'BIM' }),
    row(11, 'BIM Coordination BIM'),
    row(12, 'ניהול מודל', { code: 'MM' }),
    row(13, 'תאום מערכות'),
    row(14, 'Clash  detection'),
    row(15, 'clash-detection'),
    row(16, 'Design Review'), // a service, not the "Design" phase
  ];
}

const usage = (partial: Partial<PhaseUsage>): PhaseUsage => ({ ...EMPTY_USAGE, ...partial });

describe('PR-069 · the rule: which rows are project phases', () => {
  it('matches the nine v8-seed lifecycle phases, ignoring case, spaces and punctuation', () => {
    for (const n of PROJECT_PHASE_NAMES) expect(isProjectPhaseName(n)).toBe(true);
    expect(isProjectPhaseName('pre design')).toBe(true);
    expect(isProjectPhaseName(' CONSTRUCTION ')).toBe(true);
    expect(isProjectPhaseName('תכנון  מפורט')).toBe(true);
    expect(isProjectPhaseName('Design Review')).toBe(false);
    expect(isProjectPhaseName('BIM Coordination')).toBe(false);
    expect(isProjectPhaseName('')).toBe(false);
  });

  it('a picker offers active service rows that are not a phase', () => {
    expect(isPickableService({ name: 'BIM Coordination' })).toBe(true);
    expect(isPickableService({ name: 'Design' })).toBe(false); // before the cleanup
    expect(isPickableService({ name: 'Something', kind: 'phase' })).toBe(false); // after it
    expect(isPickableService({ name: 'Old service', isActive: false })).toBe(false);
  });
});

describe('PR-069 · plan', () => {
  const u = new Map<number, PhaseUsage>([
    [2, usage({ tasks: 40, templates: 3, projects: 4 })],
    [10, usage({ tasks: 12, templates: 2, taskCatalogItems: 5 })],
    [11, usage({ tasks: 3, projectDeliverables: 1, projects: 1 })],
  ]);

  it('lists the nine phases as mark_phase, with their usage', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u);
    const phases = candidates.filter((c) => c.action === 'mark_phase');
    expect(phases.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(phases.every((c) => c.kindGuess === 'project_phase' && c.mergeInto === null)).toBe(true);
    expect(phases.find((c) => c.id === 2)!.usage).toMatchObject({ tasks: 40, templates: 3, projects: 4 });
  });

  it('"BIM Coordination BIM" is the BIM Coordination (BIM) service twice: merge into #10', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u);
    const dup = candidates.find((c) => c.id === 11)!;
    expect(dup).toMatchObject({
      name: 'BIM Coordination BIM',
      kindGuess: 'duplicate_service',
      action: 'merge',
      mergeInto: { id: 10, name: 'BIM Coordination', code: 'BIM' },
      usage: { tasks: 3, projectDeliverables: 1 },
    });
    expect(candidates.find((c) => c.id === 10)).toBeUndefined();
  });

  it('an unused duplicate is deactivated instead of merged', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u);
    expect(candidates.find((c) => c.id === 15)).toMatchObject({
      action: 'deactivate',
      mergeInto: { id: 14 },
    });
  });

  it('real services stay out of the list', () => {
    const { candidates, unchanged } = planServicePhaseCleanup(stagingLikeRows(), u);
    const ids = candidates.map((c) => c.id);
    for (const id of [10, 12, 13, 14, 16]) expect(ids).not.toContain(id);
    expect(unchanged.map((r) => r.id)).toEqual([10, 12, 13, 14, 16]);
  });

  it('reports a ServiceType with the same name, for context', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u, [
      { id: 1, name: 'BIM Coordination', code: 'BIM' },
    ]);
    expect(candidates.find((c) => c.id === 11)!.matchingServiceType).toBeNull();
    const withSt = planServicePhaseCleanup([row(20, 'Design', { code: null })], new Map(), [
      { id: 9, name: 'design', code: 'D' },
    ]);
    expect(withSt.candidates[0].matchingServiceType).toEqual({ id: 9, name: 'design', code: 'D' });
  });

  it('is idempotent: marked or deactivated rows are not planned again', () => {
    const after = stagingLikeRows().map((r) =>
      r.id <= 9 ? { ...r, kind: 'phase' as const } : r.id === 11 || r.id === 15 ? { ...r, isActive: false } : r,
    );
    expect(planServicePhaseCleanup(after, u).candidates).toEqual([]);
  });
});

const codeOfThrow = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return { type: (e as any)?.constructor, code: (e as BadRequestException).getResponse?.() as any };
  }
  return null;
};

describe('PR-069 · body', () => {
  it('dry-run is the default; only the boolean false writes', () => {
    expect(parseServicePhaseCleanupBody(undefined)).toEqual({ dryRun: true });
    expect(parseServicePhaseCleanupBody({ dryRun: 'false' })).toEqual({ dryRun: true });
    expect(parseServicePhaseCleanupBody({ dryRun: true, approved: [{ id: 3, action: 'mark_phase' }] })).toEqual({
      dryRun: true,
      approved: [{ id: 3, action: 'mark_phase', mergeInto: null }],
    });
  });

  it('a real run needs approved: [{ id, action, mergeInto? }] (the merge target may be the dry-run object)', () => {
    const missing = codeOfThrow(() => parseServicePhaseCleanupBody({ dryRun: false }));
    expect(missing?.type).toBe(BadRequestException);
    expect(missing?.code).toMatchObject({ code: 'SERVICE_PHASE_CLEANUP_APPROVED_REQUIRED' });
    expect(parseServicePhaseCleanupBody({
      dryRun: false,
      approved: [
        { id: 2, action: 'mark_phase' },
        { id: 11, action: 'merge', mergeInto: { id: 10, name: 'BIM Coordination', code: 'BIM' } },
        { id: 15, action: 'deactivate', mergeInto: 14 },
      ],
    })).toEqual({
      dryRun: false,
      approved: [
        { id: 2, action: 'mark_phase', mergeInto: null },
        { id: 11, action: 'merge', mergeInto: 10 },
        { id: 15, action: 'deactivate', mergeInto: 14 },
      ],
    });
  });

  it('a malformed approved list is a 400', () => {
    for (const approved of [
      [],
      2,
      [{ id: '2', action: 'mark_phase' }],
      [{ id: 2, action: 'delete' }],
      [{ id: 11, action: 'merge' }], // a merge without its target
      [{ id: 11, action: 'merge', mergeInto: 'x' }],
      [{ id: 2, action: 'mark_phase' }, { id: 2, action: 'mark_phase' }],
    ]) {
      const err = codeOfThrow(() => parseServicePhaseCleanupBody({ dryRun: false, approved }));
      expect(err?.type).toBe(BadRequestException);
      expect(err?.code).toMatchObject({ code: 'SERVICE_PHASE_CLEANUP_BAD_APPROVED' });
    }
  });

  it('the old approvedIds body is refused: ids alone cannot show that the plan changed', () => {
    for (const body of [{ dryRun: false, approvedIds: [2, 11] }, { approvedIds: [2] }]) {
      const err = codeOfThrow(() => parseServicePhaseCleanupBody(body));
      expect(err?.type).toBe(BadRequestException);
      expect(err?.code).toMatchObject({ code: 'SERVICE_PHASE_CLEANUP_APPROVED_IDS_RETIRED' });
    }
  });
});

// ─── service against an in-memory Prisma ─────────────────────────────

interface Db {
  phases: PhaseRow[];
  tasks: Array<{ id: number; phaseId: number | null; projectId: number | null; deletedAt: Date | null }>;
  templates: Array<{ id: number; code: string; phaseId: number | null; deletedAt: Date | null }>;
  templateTasks: Array<{ id: number; templateId: number; phaseId: number | null }>;
  templateZoneTasks: Array<{ id: number; phaseId: number | null }>;
  projectDeliverables: Array<{ id: number; projectId: number; serviceId: number | null; deletedAt: Date | null }>;
}

function seedDb(): Db {
  return {
    phases: stagingLikeRows(),
    tasks: [
      { id: 1, phaseId: 2, projectId: 100, deletedAt: null },
      { id: 2, phaseId: 2, projectId: 101, deletedAt: null },
      { id: 3, phaseId: 11, projectId: 100, deletedAt: null },
      { id: 4, phaseId: 11, projectId: 100, deletedAt: new Date() }, // deleted, still re-pointed
      { id: 5, phaseId: 10, projectId: 100, deletedAt: null },
    ],
    templates: [
      { id: 1, code: '__TASK_CATALOG__', phaseId: null, deletedAt: null },
      { id: 41, code: 'CRD', phaseId: 11, deletedAt: null },
      { id: 42, code: 'DSG', phaseId: 2, deletedAt: null },
    ],
    templateTasks: [
      { id: 1, templateId: 1, phaseId: 11 }, // catalog item
      { id: 2, templateId: 41, phaseId: 11 },
    ],
    templateZoneTasks: [{ id: 1, phaseId: 11 }],
    projectDeliverables: [{ id: 1, projectId: 102, serviceId: 11, deletedAt: null }],
  };
}

function makePrisma(db: Db) {
  const writes: string[] = [];
  const inIds = (w: any, key: string) => w?.[key]?.in as number[];
  const group = (rows: any[], key: string, where: any, extra: (r: any) => boolean = () => true) => {
    const ids = inIds(where, key);
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (!ids.includes(r[key]) || !extra(r)) continue;
      if ('deletedAt' in where && r.deletedAt != null) continue;
      counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
    }
    return [...counts].map(([id, n]) => ({ [key]: id, _count: { _all: n } }));
  };
  const isCatalog = (templateId: number) => db.templates.find((t) => t.id === templateId)?.code === '__TASK_CATALOG__';
  const updateMany = (rows: any[], key: string, label: string) =>
    jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) {
        if (r[key] === where[key]) {
          r[key] = data[key];
          count++;
        }
      }
      writes.push(`${label}:${where[key]}->${data[key]}:${count}`);
      return { count };
    });
  const tx: any = {
    phase: {
      update: jest.fn(async ({ where, data }: any) => {
        const p = db.phases.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        writes.push(`phase:${where.id}:${JSON.stringify(data)}`);
        return p;
      }),
      delete: jest.fn(async () => {
        throw new Error('must never delete');
      }),
    },
    task: { updateMany: updateMany(db.tasks, 'phaseId', 'task') },
    template: { updateMany: updateMany(db.templates, 'phaseId', 'template') },
    templateTask: { updateMany: updateMany(db.templateTasks, 'phaseId', 'templateTask') },
    templateZoneTask: { updateMany: updateMany(db.templateZoneTasks, 'phaseId', 'templateZoneTask') },
    projectDeliverable: { updateMany: updateMany(db.projectDeliverables, 'serviceId', 'projectDeliverable') },
  };
  const prisma: any = {
    phase: { findMany: jest.fn(async () => db.phases.map((p) => ({ ...p }))) },
    serviceType: { findMany: jest.fn(async () => [{ id: 1, name: 'BIM Coordination', code: 'BIM' }]) },
    task: {
      groupBy: jest.fn(async ({ where }: any) => group(db.tasks, 'phaseId', where)),
      findMany: jest.fn(async ({ where }: any) => {
        const seen = new Set<string>();
        return db.tasks
          .filter((t) => inIds(where, 'phaseId').includes(t.phaseId as number) && t.deletedAt == null && t.projectId != null)
          .filter((t) => !seen.has(`${t.phaseId}:${t.projectId}`) && !!seen.add(`${t.phaseId}:${t.projectId}`))
          .map((t) => ({ phaseId: t.phaseId, projectId: t.projectId }));
      }),
    },
    template: {
      groupBy: jest.fn(async ({ where }: any) =>
        group(db.templates, 'phaseId', where, (t) => t.code !== '__TASK_CATALOG__'),
      ),
    },
    templateTask: {
      groupBy: jest.fn(async ({ where }: any) =>
        group(db.templateTasks, 'phaseId', where, (t) =>
          where.template.code === '__TASK_CATALOG__' ? isCatalog(t.templateId) : !isCatalog(t.templateId),
        ),
      ),
    },
    templateZoneTask: { groupBy: jest.fn(async ({ where }: any) => group(db.templateZoneTasks, 'phaseId', where)) },
    projectDeliverable: {
      groupBy: jest.fn(async ({ where }: any) => group(db.projectDeliverables, 'serviceId', where)),
      findMany: jest.fn(async ({ where }: any) =>
        db.projectDeliverables
          .filter((d) => inIds(where, 'serviceId').includes(d.serviceId as number) && d.deletedAt == null)
          .map((d) => ({ serviceId: d.serviceId, projectId: d.projectId })),
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, tx, writes };
}

describe('PR-069 · run', () => {
  it('dry-run: every candidate with id, name, code, kind guess, usage and action; nothing written', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.totalRows).toBe(16);
    expect(res.applied).toBeNull();
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.candidates.map((c) => [c.id, c.action])).toEqual([
      [1, 'mark_phase'],
      [2, 'mark_phase'],
      [3, 'mark_phase'],
      [4, 'mark_phase'],
      [5, 'mark_phase'],
      [6, 'mark_phase'],
      [7, 'mark_phase'],
      [8, 'mark_phase'],
      [9, 'mark_phase'],
      [11, 'merge'],
      [15, 'deactivate'],
    ]);
    expect(res.candidates.find((c) => c.id === 11)).toMatchObject({
      name: 'BIM Coordination BIM',
      code: null,
      kindGuess: 'duplicate_service',
      mergeInto: { id: 10 },
      usage: {
        tasks: 1, // live only
        templates: 1,
        taskCatalogItems: 1,
        templateTasks: 2, // template task + zone task
        projectDeliverables: 1,
        projects: 2,
      },
    });
    expect(res.candidates.find((c) => c.id === 2)!.usage).toMatchObject({ tasks: 2, templates: 1, projects: 2 });
  });

  it('real run acts only on approved ids; merge re-points every reference, nothing is deleted', async () => {
    const db = seedDb();
    const { prisma, tx } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({
      dryRun: false,
      approved: [
        { id: 2, action: 'mark_phase', mergeInto: null },
        { id: 11, action: 'merge', mergeInto: 10 },
        { id: 999, action: 'deactivate', mergeInto: null },
      ],
    });

    expect(res.notCandidates).toEqual([999]);
    expect(res.notApproved).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 15]);
    expect(res.applied).toEqual([
      {
        id: 11,
        action: 'merge',
        mergeInto: 10,
        repointed: { tasks: 2, templates: 1, templateTasks: 2, templateZoneTasks: 1, projectDeliverables: 1 },
      },
      { id: 2, action: 'mark_phase', mergeInto: null, repointed: null },
    ]);

    // Nothing points at #11 any more; every row that did now points at #10.
    expect(db.tasks.filter((t) => t.phaseId === 11)).toEqual([]);
    expect(db.tasks.filter((t) => t.phaseId === 10).map((t) => t.id)).toEqual([3, 4, 5]);
    expect(db.templates.find((t) => t.id === 41)!.phaseId).toBe(10);
    expect(db.templateTasks.every((t) => t.phaseId === 10)).toBe(true);
    expect(db.templateZoneTasks[0].phaseId).toBe(10);
    expect(db.projectDeliverables[0].serviceId).toBe(10);
    // #11 is kept, inactive; #2 is kept, marked; its tasks untouched.
    expect(db.phases.find((p) => p.id === 11)).toMatchObject({ isActive: false, kind: 'service' });
    expect(db.phases.find((p) => p.id === 2)).toMatchObject({ isActive: true, kind: 'phase' });
    expect(db.tasks.filter((t) => t.phaseId === 2).map((t) => t.id)).toEqual([1, 2]);
    // Unapproved candidates untouched.
    expect(db.phases.find((p) => p.id === 1)).toMatchObject({ kind: 'service', isActive: true });
    expect(db.phases.find((p) => p.id === 15)).toMatchObject({ isActive: true });
    expect(tx.phase.delete).not.toHaveBeenCalled();
  });

  it('a second run plans nothing for the rows already done', async () => {
    const db = seedDb();
    const { prisma } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    const first = await svc.run({ dryRun: true });
    await svc.run({
      dryRun: false,
      approved: first.candidates.map((c) => ({ id: c.id, action: c.action, mergeInto: c.mergeInto?.id ?? null })),
    });
    const again = await svc.run({ dryRun: true });
    expect(again.candidates).toEqual([]);
  });

  it('409 and nothing written when an approved row now plans another action (data changed since the dry-run)', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    const dry = await svc.run({ dryRun: true });
    expect(dry.candidates.find((c) => c.id === 15)).toMatchObject({ action: 'deactivate', mergeInto: { id: 14 } });

    // After the review, tasks start using both duplicates (#14 more): #14
    // still stays, and #15 is now in use, so its plan becomes a merge.
    db.tasks.push(
      { id: 6, phaseId: 15, projectId: 100, deletedAt: null },
      { id: 7, phaseId: 14, projectId: 100, deletedAt: null },
      { id: 8, phaseId: 14, projectId: 101, deletedAt: null },
    );
    const err = await svc
      .run({
        dryRun: false,
        approved: [
          { id: 2, action: 'mark_phase', mergeInto: null },
          { id: 15, action: 'deactivate', mergeInto: 14 },
        ],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: 'SERVICE_PHASE_CLEANUP_PLAN_CHANGED',
      details: {
        mismatches: [
          { id: 15, approved: { action: 'deactivate', mergeInto: 14 }, planned: { action: 'merge', mergeInto: 14 } },
        ],
      },
    });
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.phases.find((p) => p.id === 2)).toMatchObject({ kind: 'service' }); // not even the matching row
  });

  it('409 when an approved merge target is not the planned one', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const err = await new Qa6ServicePhaseCleanupService(prisma)
      .run({ dryRun: false, approved: [{ id: 11, action: 'merge', mergeInto: 13 }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().details.mismatches).toEqual([
      { id: 11, approved: { action: 'merge', mergeInto: 13 }, planned: { action: 'merge', mergeInto: 10 } },
    ]);
    expect(writes).toEqual([]);
  });

  it('a dry-run with the approved list runs the same check, so it tells whether the real run would pass', async () => {
    const { prisma } = makePrisma(seedDb());
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    await expect(svc.run({ dryRun: true, approved: [{ id: 11, action: 'deactivate', mergeInto: 10 }] })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const ok = await svc.run({ dryRun: true, approved: [{ id: 11, action: 'merge', mergeInto: 10 }] });
    expect(ok.applied).toBeNull();
    expect(ok.approved).toEqual([{ id: 11, action: 'merge', mergeInto: 10 }]);
  });
});

describe('PR-069 · wiring', () => {
  it('POST admin/backfills/qa6-service-phase-cleanup, admin:write, dry-run unless dryRun:false + approved', async () => {
    const handler = BackfillsController.prototype.runQa6ServicePhaseCleanup;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('qa6-service-phase-cleanup');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([{ module: 'admin', action: 'write' }]);
    expect(Reflect.getMetadata('providers', AdminModule)).toContain(Qa6ServicePhaseCleanupService);

    const service = { run: jest.fn(async (b: any) => b) };
    const controller = new BackfillsController({} as never, {} as never, {} as never, {} as never, {} as never, service as never);
    await controller.runQa6ServicePhaseCleanup({ id: 7 }, undefined);
    expect(service.run).toHaveBeenLastCalledWith({ dryRun: true, actorId: 7 });
    await expect(controller.runQa6ServicePhaseCleanup({ id: 7 }, { dryRun: false })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.runQa6ServicePhaseCleanup({ id: 7 }, { dryRun: false, approvedIds: [2] } as any)).rejects.toThrow(
      BadRequestException,
    );
    await controller.runQa6ServicePhaseCleanup({ id: 7 }, { dryRun: false, approved: [{ id: 2, action: 'mark_phase' }] });
    expect(service.run).toHaveBeenLastCalledWith({
      dryRun: false,
      approved: [{ id: 2, action: 'mark_phase', mergeInto: null }],
      actorId: 7,
    });
  });

  it('GET /phases?scope=services leaves project phases out before the cleanup runs', async () => {
    const rows = stagingLikeRows().map((r) => ({ ...r, sortOrder: r.id }));
    rows.find((r) => r.id === 15)!.isActive = false;
    const prisma: any = { phase: { findMany: jest.fn(async () => rows) } };
    const ctrl = new PhasesController(new PhasesService(prisma));
    const all = (await ctrl.findAll()) as any[];
    const services = (await ctrl.findAll('services')) as any[];
    expect(all).toHaveLength(16);
    expect(services.map((r) => r.id)).toEqual([10, 11, 12, 13, 14, 16]);
    expect(() => ctrl.findAll('phases')).toThrow(BadRequestException);
  });
});
