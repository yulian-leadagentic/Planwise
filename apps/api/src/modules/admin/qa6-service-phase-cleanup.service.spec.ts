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
 *
 * 2026-11-26 (owner: merge "BIM Coordination BIM" into "BIM Coordination"):
 *   • a name that ends with a word it already has, and is another live
 *     row's name without that word, is a duplicate (rule 3), even when
 *     the code does not match ("BIM Coordination" has code BMC);
 *   • unchanged rows carry the same usage counts as candidates;
 *   • the `service_types` table gets the same duplicate check in the same
 *     dry-run / run (every row tagged with its `table`); a merge
 *     re-points every reference (tasks, template tasks, template zone
 *     tasks, zone links, project categories) in one transaction and
 *     deactivates the duplicate (new `service_types.is_active`).
 */
import { BadRequestException, ConflictException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PhasesController } from '../phases/phases.controller';
import { PhasesService } from '../phases/phases.service';
import { isPickableService, isProjectPhaseName, PROJECT_PHASE_NAMES } from '../phases/service-phase-rule';
import { ServiceTypesService } from '../service-types/service-types.service';
import { AdminModule } from './admin.module';
import { BackfillsController } from './backfills.controller';
import {
  EMPTY_SERVICE_TYPE_USAGE,
  EMPTY_USAGE,
  type PhaseRow,
  type PhaseUsage,
  planServicePhaseCleanup,
  planServiceTypeDuplicates,
  repeatedLastWord,
  type ServiceTypeUsage,
} from './qa6-service-phase-cleanup.plan';
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
/** En dash or em dash: never in a user-visible message or reason. */
const longDash = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const stUsage = (partial: Partial<ServiceTypeUsage>): ServiceTypeUsage => ({ ...EMPTY_SERVICE_TYPE_USAGE, ...partial });

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
    expect(phases.every((c) => c.kindGuess === 'project_phase' && c.mergeInto === null && c.table === 'phases')).toBe(true);
    expect(phases.find((c) => c.id === 2)!.usage).toMatchObject({ tasks: 40, templates: 3, projects: 4 });
  });

  it('"BIM Coordination BIM" is the BIM Coordination (BIM) service twice: merge into #10', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u);
    const dup = candidates.find((c) => c.id === 11)!;
    expect(dup).toMatchObject({
      table: 'phases',
      name: 'BIM Coordination BIM',
      kindGuess: 'duplicate_service',
      action: 'merge',
      mergeInto: { id: 10, name: 'BIM Coordination', code: 'BIM' },
      usage: { tasks: 3, projectDeliverables: 1 },
      reason: 'Same service as #10 "BIM Coordination" (BIM): the name is that name followed by its code "BIM".',
    });
    expect(candidates.find((c) => c.id === 10)).toBeUndefined();
  });

  it('an unused duplicate is deactivated instead of merged', () => {
    const { candidates } = planServicePhaseCleanup(stagingLikeRows(), u);
    expect(candidates.find((c) => c.id === 15)).toMatchObject({
      action: 'deactivate',
      mergeInto: { id: 14 },
      reason: 'Same service as #14 "Clash  detection": the same name once case, spaces and punctuation are ignored.',
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

describe('PR-069 · duplicate rule 3: the name repeats its last word', () => {
  it('finds the repeated last word and the name without it', () => {
    expect(repeatedLastWord('BIM Coordination BIM')).toEqual({ word: 'BIM', key: 'bimcoordination' });
    expect(repeatedLastWord('bim-coordination  Bim')).toEqual({ word: 'Bim', key: 'bimcoordination' });
    expect(repeatedLastWord('BIM BIM')).toEqual({ word: 'BIM', key: 'bim' });
    for (const name of ['BIM Management Basic', 'VDC Quantity', 'CAD Cooreination', 'BIM to BIM Review', 'BIM', '', null]) {
      expect(repeatedLastWord(name)).toBeNull();
    }
  });

  // Staging today: #7 "BIM Coordination" has code BMC, so rule 2 ("name +
  // the other row's code") does not see #17 "BIM Coordination BIM".
  const staging = () => [row(7, 'BIM Coordination', { code: 'BMC' }), row(17, 'BIM Coordination BIM')];

  it('"BIM Coordination BIM" next to "BIM Coordination" (code BMC), used: merge into #7', () => {
    const { candidates, unchanged } = planServicePhaseCleanup(staging(), new Map([[17, usage({ tasks: 2, projects: 1 })]]));
    expect(candidates).toEqual([
      {
        table: 'phases',
        id: 17,
        name: 'BIM Coordination BIM',
        code: null,
        kindGuess: 'duplicate_service',
        reason: 'Same service as #7 "BIM Coordination" (BMC): the name is that name with its word "BIM" repeated at the end.',
        usage: usage({ tasks: 2, projects: 1 }),
        action: 'merge',
        mergeInto: { id: 7, name: 'BIM Coordination', code: 'BMC' },
        matchingServiceType: null,
      },
    ]);
    expect(unchanged.map((r) => r.id)).toEqual([7]);
  });

  it('unused: deactivate, the row that stays is still #7', () => {
    const { candidates } = planServicePhaseCleanup(staging(), new Map());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 17, action: 'deactivate', mergeInto: { id: 7 } });
  });

  it('the row without the extra word stays, even when the duplicate is older and used more', () => {
    const rows = [row(3, 'BIM Coordination BIM'), row(7, 'BIM Coordination', { code: 'BMC' })];
    const { candidates } = planServicePhaseCleanup(rows, new Map([[3, usage({ tasks: 50 })]]));
    expect(candidates.map((c) => [c.id, c.action, c.mergeInto?.id])).toEqual([[3, 'merge', 7]]);
  });

  it('does not flag legitimate names', () => {
    const rows = [
      row(1, 'BIM Management'),
      row(2, 'BIM Management Basic'),
      row(3, 'VDC'),
      row(4, 'VDC Quantity'),
      row(5, 'CAD Coordination'),
      row(6, 'CAD Cooreination'),
      row(7, 'BIM Review'),
      row(8, 'BIM to BIM Review'), // a word repeated in the middle
      row(9, 'Survey Survey'), // repeats its last word, but there is no "Survey" row
    ];
    const used = new Map(rows.map((r) => [r.id, usage({ tasks: 1 })]));
    const { candidates, unchanged } = planServicePhaseCleanup(rows, used);
    expect(candidates).toEqual([]);
    expect(unchanged).toHaveLength(rows.length);
  });

  it('only live service rows count: no match against an inactive row or a phase row', () => {
    expect(
      planServicePhaseCleanup(
        [row(7, 'BIM Coordination', { isActive: false }), row(17, 'BIM Coordination BIM')],
        new Map(),
      ).candidates,
    ).toEqual([]);
    expect(
      planServicePhaseCleanup([row(7, 'BIM Coordination', { kind: 'phase' }), row(17, 'BIM Coordination BIM')], new Map())
        .candidates,
    ).toEqual([]);
  });

  it('the same rule runs on service_types (and only the duplicate rules, never the phase rule)', () => {
    const { candidates, unchanged } = planServiceTypeDuplicates(
      [
        { id: 13, name: 'BIM Coordination', code: null, isActive: true },
        { id: 14, name: 'BIM Coordination BIM', code: null, isActive: true },
        { id: 20, name: 'Design', code: null, isActive: true },
        { id: 21, name: 'VDC Quantity', code: null, isActive: true },
        { id: 22, name: 'Old Old', code: null, isActive: true },
        { id: 23, name: 'Old', code: null, isActive: false },
      ],
      new Map([[14, stUsage({ tasks: 1, zoneLinks: 2 })]]),
    );
    expect(candidates).toEqual([
      {
        table: 'service_types',
        id: 14,
        name: 'BIM Coordination BIM',
        code: null,
        kindGuess: 'duplicate_service',
        reason: 'Same service type as #13 "BIM Coordination": the name is that name with its word "BIM" repeated at the end.',
        usage: stUsage({ tasks: 1, zoneLinks: 2 }),
        action: 'merge',
        mergeInto: { id: 13, name: 'BIM Coordination', code: null },
        linksAlreadyOnKeeper: null,
      },
    ]);
    expect(unchanged.map((r) => r.id)).toEqual([13, 20, 21, 22, 23]);
    expect(
      planServiceTypeDuplicates(
        [
          { id: 13, name: 'BIM Coordination', code: null },
          { id: 14, name: 'BIM Coordination BIM', code: null },
        ],
        new Map(),
      ).candidates[0],
    ).toMatchObject({ id: 14, action: 'deactivate', mergeInto: { id: 13 } });
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
      approved: [{ table: 'phases', id: 3, action: 'mark_phase', mergeInto: null }],
    });
  });

  it('a real run needs approved: [{ table?, id, action, mergeInto? }] (the merge target may be the dry-run object)', () => {
    const missing = codeOfThrow(() => parseServicePhaseCleanupBody({ dryRun: false }));
    expect(missing?.type).toBe(BadRequestException);
    expect(missing?.code).toMatchObject({ code: 'SERVICE_PHASE_CLEANUP_APPROVED_REQUIRED' });
    expect(parseServicePhaseCleanupBody({
      dryRun: false,
      approved: [
        { id: 2, action: 'mark_phase' },
        { id: 11, action: 'merge', mergeInto: { id: 10, name: 'BIM Coordination', code: 'BIM' } },
        { id: 15, action: 'deactivate', mergeInto: 14 },
        { table: 'service_types', id: 14, action: 'merge', mergeInto: { id: 13, name: 'BIM Coordination', code: null } },
        { table: 'phases', id: 14, action: 'deactivate' }, // the same id in the other table is another row
      ],
    })).toEqual({
      dryRun: false,
      approved: [
        { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null },
        { table: 'phases', id: 11, action: 'merge', mergeInto: 10 },
        { table: 'phases', id: 15, action: 'deactivate', mergeInto: 14 },
        { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
        { table: 'phases', id: 14, action: 'deactivate', mergeInto: null },
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
      [{ id: 2, action: 'mark_phase' }, { table: 'phases', id: 2, action: 'mark_phase' }],
      [{ table: 'zones', id: 2, action: 'deactivate' }],
      [{ table: 'service_types', id: 14, action: 'mark_phase' }], // service types are never phases
      [{ table: 'service_types', id: 14, action: 'merge' }],
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

  it('no long dashes in the messages', () => {
    for (const body of [{ approvedIds: [2] }, { dryRun: false }, { dryRun: false, approved: [{ table: 'x', id: 1 }] }]) {
      expect(JSON.stringify(codeOfThrow(() => parseServicePhaseCleanupBody(body))?.code)).not.toMatch(longDash);
    }
  });
});

// ─── service against an in-memory Prisma ─────────────────────────────

interface Db {
  phases: PhaseRow[];
  serviceTypes: Array<{ id: number; name: string; code: string | null; isActive: boolean }>;
  tasks: Array<{
    id: number;
    phaseId: number | null;
    serviceTypeId?: number | null;
    projectId: number | null;
    deletedAt: Date | null;
  }>;
  templates: Array<{ id: number; code: string; phaseId: number | null; deletedAt: Date | null }>;
  templateTasks: Array<{ id: number; templateId: number; phaseId: number | null; serviceTypeId?: number | null }>;
  templateZoneTasks: Array<{ id: number; phaseId: number | null; serviceTypeId?: number | null }>;
  projectDeliverables: Array<{ id: number; projectId: number; serviceId: number | null; deletedAt: Date | null }>;
  zoneServiceTypes: Array<{ id: number; zoneId: number; serviceTypeId: number }>;
  projectCategories: Array<{ id: number; projectId: number; serviceTypeId: number }>;
}

function seedDb(): Db {
  return {
    phases: stagingLikeRows(),
    serviceTypes: [
      { id: 1, name: 'MEP', code: 'MEP', isActive: true },
      { id: 13, name: 'BIM Coordination', code: 'BC', isActive: true },
      { id: 14, name: 'BIM Coordination BIM', code: null, isActive: true }, // used: merge into #13
      { id: 15, name: 'Structural', code: null, isActive: true },
      { id: 16, name: 'Structural Structural', code: null, isActive: true }, // unused: deactivate
      { id: 17, name: 'BIM to BIM Review', code: null, isActive: true },
      { id: 18, name: 'VDC Quantity', code: null, isActive: true },
    ],
    tasks: [
      { id: 1, phaseId: 2, serviceTypeId: 13, projectId: 100, deletedAt: null },
      { id: 2, phaseId: 2, serviceTypeId: null, projectId: 101, deletedAt: null },
      { id: 3, phaseId: 11, serviceTypeId: 14, projectId: 100, deletedAt: null },
      { id: 4, phaseId: 11, serviceTypeId: 14, projectId: 100, deletedAt: new Date() }, // deleted, still re-pointed
      { id: 5, phaseId: 10, serviceTypeId: 1, projectId: 100, deletedAt: null },
    ],
    templates: [
      { id: 1, code: '__TASK_CATALOG__', phaseId: null, deletedAt: null },
      { id: 41, code: 'CRD', phaseId: 11, deletedAt: null },
      { id: 42, code: 'DSG', phaseId: 2, deletedAt: null },
    ],
    templateTasks: [
      { id: 1, templateId: 1, phaseId: 11, serviceTypeId: 14 }, // catalog item
      { id: 2, templateId: 41, phaseId: 11, serviceTypeId: 14 },
      { id: 3, templateId: 42, phaseId: 10, serviceTypeId: 13 },
    ],
    templateZoneTasks: [{ id: 1, phaseId: 11, serviceTypeId: 14 }],
    projectDeliverables: [{ id: 1, projectId: 102, serviceId: 11, deletedAt: null }],
    zoneServiceTypes: [
      { id: 1, zoneId: 500, serviceTypeId: 14 },
      { id: 2, zoneId: 501, serviceTypeId: 14 }, // zone 501 already has #13
      { id: 3, zoneId: 501, serviceTypeId: 13 },
    ],
    projectCategories: [
      { id: 1, projectId: 100, serviceTypeId: 14 }, // project 100 already has #13
      { id: 2, projectId: 102, serviceTypeId: 14 },
      { id: 3, projectId: 100, serviceTypeId: 13 },
    ],
  };
}

/** A small Prisma over the arrays of `db`: equality, in, notIn, not, and the template-code relation filter. */
function makePrisma(db: Db) {
  const writes: string[] = [];
  const valueMatches = (v: unknown, cond: any): boolean => {
    if (cond === null) return v == null;
    if (cond && typeof cond === 'object') {
      if ('in' in cond) return cond.in.includes(v);
      if ('notIn' in cond) return !cond.notIn.includes(v);
      if ('not' in cond) return cond.not === null ? v != null : v !== cond.not;
    }
    return v === cond;
  };
  const matches = (r: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, cond]: [string, any]) =>
      k === 'template'
        ? valueMatches(db.templates.find((t) => t.id === r.templateId)?.code, cond.code)
        : valueMatches(r[k], cond),
    );
  const model = (rows: any[], label: string) => ({
    groupBy: jest.fn(async ({ by, where }: any) => {
      const key = by[0];
      const counts = new Map<number, number>();
      for (const r of rows) if (matches(r, where)) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
      return [...counts].map(([id, n]) => ({ [key]: id, _count: { _all: n } }));
    }),
    findMany: jest.fn(async ({ where, select, distinct }: any = {}) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const r of rows) {
        if (!matches(r, where)) continue;
        if (distinct) {
          const sig = distinct.map((k: string) => r[k]).join(':');
          if (seen.has(sig)) continue;
          seen.add(sig);
        }
        out.push(select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r });
      }
      return out;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) {
        if (!matches(r, where)) continue;
        Object.assign(r, data);
        count++;
      }
      writes.push(`${label}.updateMany:${JSON.stringify(where)}->${JSON.stringify(data)}:${count}`);
      return { count };
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!matches(rows[i], where)) continue;
        rows.splice(i, 1);
        count++;
      }
      writes.push(`${label}.deleteMany:${JSON.stringify(where)}:${count}`);
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      writes.push(`${label}:${where.id}:${JSON.stringify(data)}`);
      return r;
    }),
    delete: jest.fn(async () => {
      throw new Error('must never delete');
    }),
  });
  const models = {
    phase: model(db.phases, 'phase'),
    serviceType: model(db.serviceTypes, 'serviceType'),
    task: model(db.tasks, 'task'),
    template: model(db.templates, 'template'),
    templateTask: model(db.templateTasks, 'templateTask'),
    templateZoneTask: model(db.templateZoneTasks, 'templateZoneTask'),
    projectDeliverable: model(db.projectDeliverables, 'projectDeliverable'),
    zoneServiceType: model(db.zoneServiceTypes, 'zoneServiceType'),
    projectCategory: model(db.projectCategories, 'projectCategory'),
  };
  const prisma: any = { ...models, $transaction: jest.fn(async (fn: any) => fn(models)) };
  return { prisma, tx: models, writes };
}

const asApproved = (cs: Array<{ table: any; id: number; action: any; mergeInto: { id: number } | null }>) =>
  cs.map((c) => ({ table: c.table, id: c.id, action: c.action, mergeInto: c.mergeInto?.id ?? null }));

describe('PR-069 · run', () => {
  it('dry-run: every candidate of both tables with table, id, name, code, kind guess, usage and action; nothing written', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.totalRows).toBe(23);
    expect(res.rowsByTable).toEqual({ phases: 16, service_types: 7 });
    expect(res.applied).toBeNull();
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(res.candidates.map((c) => [c.table, c.id, c.action])).toEqual([
      ['phases', 1, 'mark_phase'],
      ['phases', 2, 'mark_phase'],
      ['phases', 3, 'mark_phase'],
      ['phases', 4, 'mark_phase'],
      ['phases', 5, 'mark_phase'],
      ['phases', 6, 'mark_phase'],
      ['phases', 7, 'mark_phase'],
      ['phases', 8, 'mark_phase'],
      ['phases', 9, 'mark_phase'],
      ['phases', 11, 'merge'],
      ['phases', 15, 'deactivate'],
      ['service_types', 14, 'merge'],
      ['service_types', 16, 'deactivate'],
    ]);
    expect(res.candidates.find((c) => c.table === 'phases' && c.id === 11)).toMatchObject({
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
    expect(res.candidates.find((c) => c.table === 'phases' && c.id === 2)!.usage).toMatchObject({
      tasks: 2,
      templates: 1,
      projects: 2,
    });
    expect(res.candidates.find((c) => c.table === 'service_types' && c.id === 14)).toEqual({
      table: 'service_types',
      id: 14,
      name: 'BIM Coordination BIM',
      code: null,
      kindGuess: 'duplicate_service',
      reason: 'Same service type as #13 "BIM Coordination" (BC): the name is that name with its word "BIM" repeated at the end.',
      usage: {
        tasks: 1, // live only
        taskCatalogItems: 1,
        templateTasks: 2, // template task + zone task
        zoneLinks: 2,
        projectCategories: 2,
        projects: 2, // 100 (task, category) and 102 (category)
      },
      action: 'merge',
      mergeInto: { id: 13, name: 'BIM Coordination', code: 'BC' },
      linksAlreadyOnKeeper: { zoneLinks: 1, projectCategories: 1 },
    });
    expect(res.candidates.find((c) => c.table === 'service_types' && c.id === 16)).toMatchObject({
      action: 'deactivate',
      mergeInto: { id: 15, name: 'Structural' },
      usage: EMPTY_SERVICE_TYPE_USAGE,
      linksAlreadyOnKeeper: null,
    });
    for (const c of res.candidates) expect(c.reason).not.toMatch(longDash);
  });

  it('unchanged rows of both tables carry the same usage counts as candidates', async () => {
    const { prisma } = makePrisma(seedDb());
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({ dryRun: true });
    expect(res.unchanged.map((r) => [r.table, r.id])).toEqual([
      ['phases', 10],
      ['phases', 12],
      ['phases', 13],
      ['phases', 14],
      ['phases', 16],
      ['service_types', 1],
      ['service_types', 13],
      ['service_types', 15],
      ['service_types', 17],
      ['service_types', 18],
    ]);
    expect(res.unchanged.find((r) => r.table === 'phases' && r.id === 10)).toEqual({
      table: 'phases',
      id: 10,
      name: 'BIM Coordination',
      code: 'BIM',
      kind: 'service',
      isActive: true,
      usage: usage({ tasks: 1, templateTasks: 1, projects: 1 }),
    });
    expect(res.unchanged.find((r) => r.table === 'phases' && r.id === 12)!.usage).toEqual(EMPTY_USAGE);
    expect(res.unchanged.find((r) => r.table === 'service_types' && r.id === 13)).toEqual({
      table: 'service_types',
      id: 13,
      name: 'BIM Coordination',
      code: 'BC',
      isActive: true,
      usage: stUsage({ tasks: 1, templateTasks: 1, zoneLinks: 1, projectCategories: 1, projects: 1 }),
    });
    expect(res.unchanged.every((r) => r.usage !== undefined)).toBe(true);
  });

  it('real run acts only on approved ids; merge re-points every reference, nothing is deleted', async () => {
    const db = seedDb();
    const { prisma, tx } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({
      dryRun: false,
      approved: [
        { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null },
        { table: 'phases', id: 11, action: 'merge', mergeInto: 10 },
        { table: 'phases', id: 999, action: 'deactivate', mergeInto: null },
      ],
    });

    expect(res.notCandidates).toEqual([{ table: 'phases', id: 999 }]);
    expect(res.notApproved).toEqual([
      ...[1, 3, 4, 5, 6, 7, 8, 9, 15].map((id) => ({ table: 'phases', id })),
      { table: 'service_types', id: 14 },
      { table: 'service_types', id: 16 },
    ]);
    expect(res.applied).toEqual([
      {
        table: 'phases',
        id: 11,
        action: 'merge',
        mergeInto: 10,
        repointed: { tasks: 2, templates: 1, templateTasks: 2, templateZoneTasks: 1, projectDeliverables: 1 },
      },
      { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null, repointed: null },
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
    // Unapproved candidates untouched, service types included.
    expect(db.phases.find((p) => p.id === 1)).toMatchObject({ kind: 'service', isActive: true });
    expect(db.phases.find((p) => p.id === 15)).toMatchObject({ isActive: true });
    expect(db.serviceTypes.every((st) => st.isActive)).toBe(true);
    expect(db.tasks.filter((t) => t.serviceTypeId === 14).map((t) => t.id)).toEqual([3, 4]);
    expect(tx.phase.delete).not.toHaveBeenCalled();
  });

  it('service_types merge re-points every reference to the row that stays, in one transaction, then deactivates the duplicate', async () => {
    const db = seedDb();
    const { prisma, tx } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({
      dryRun: false,
      approved: [
        { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
        { table: 'service_types', id: 16, action: 'deactivate', mergeInto: 15 },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.notCandidates).toEqual([]);
    expect(res.applied).toEqual([
      {
        table: 'service_types',
        id: 14,
        action: 'merge',
        mergeInto: 13,
        repointed: {
          tasks: 2, // the deleted task too
          templateTasks: 2, // catalog item + template task
          templateZoneTasks: 1,
          zoneLinks: 1, // zone 500 moved
          zoneLinksAlreadyOnKeeper: 1, // zone 501 already linked to #13
          projectCategories: 1, // project 102 moved
          projectCategoriesAlreadyOnKeeper: 1, // project 100 already had #13
        },
      },
      { table: 'service_types', id: 16, action: 'deactivate', mergeInto: 15, repointed: null },
    ]);

    // No reference to #14 is left in any table.
    expect(db.tasks.filter((t) => t.serviceTypeId === 14)).toEqual([]);
    expect(db.templateTasks.filter((t) => t.serviceTypeId === 14)).toEqual([]);
    expect(db.templateZoneTasks.filter((t) => t.serviceTypeId === 14)).toEqual([]);
    expect(db.zoneServiceTypes.filter((z) => z.serviceTypeId === 14)).toEqual([]);
    expect(db.projectCategories.filter((p) => p.serviceTypeId === 14)).toEqual([]);
    // Everything that pointed at #14 now points at #13, one link per zone / project.
    expect(db.tasks.filter((t) => t.serviceTypeId === 13).map((t) => t.id)).toEqual([1, 3, 4]);
    expect(db.templateTasks.filter((t) => t.serviceTypeId === 13).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(db.templateZoneTasks[0].serviceTypeId).toBe(13);
    expect(db.zoneServiceTypes.map((z) => [z.zoneId, z.serviceTypeId]).sort()).toEqual([
      [500, 13],
      [501, 13],
    ]);
    expect(db.projectCategories.map((p) => [p.projectId, p.serviceTypeId]).sort()).toEqual([
      [100, 13],
      [102, 13],
    ]);
    // Both duplicates kept, inactive; the rows that stay, active. No catalog row deleted.
    expect(db.serviceTypes.map((st) => [st.id, st.isActive])).toEqual([
      [1, true],
      [13, true],
      [14, false],
      [15, true],
      [16, false],
      [17, true],
      [18, true],
    ]);
    expect(tx.serviceType.delete).not.toHaveBeenCalled();
    expect(tx.phase.delete).not.toHaveBeenCalled();
    // The phases table is not touched by a service_types approval.
    expect(tx.phase.update).not.toHaveBeenCalled();
    expect(db.tasks.find((t) => t.id === 3)!.phaseId).toBe(11);
  });

  it('an approved entry without table is a phases row: it never acts on the service_types row with that id', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const res = await new Qa6ServicePhaseCleanupService(prisma).run({
      dryRun: false,
      approved: parseServicePhaseCleanupBody({ dryRun: false, approved: [{ id: 16, action: 'deactivate', mergeInto: 15 }] })
        .approved,
    });
    expect(res.notCandidates).toEqual([{ table: 'phases', id: 16 }]); // phases #16 "Design Review" is no candidate
    expect(res.applied).toEqual([]);
    expect(writes).toEqual([]);
    expect(db.serviceTypes.find((st) => st.id === 16)!.isActive).toBe(true);
  });

  it('a second run plans nothing for the rows already done (both tables), and a repeated real run writes nothing', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    const first = await svc.run({ dryRun: true });
    const approved = asApproved(first.candidates);
    await svc.run({ dryRun: false, approved });
    const again = await svc.run({ dryRun: true });
    expect(again.candidates).toEqual([]);

    const writesBefore = writes.length;
    const repeat = await svc.run({ dryRun: false, approved });
    expect(repeat.applied).toEqual([]);
    expect(repeat.notCandidates).toHaveLength(approved.length);
    expect(writes).toHaveLength(writesBefore);
  });

  it('409 and nothing written when an approved row now plans another action (data changed since the dry-run)', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    const dry = await svc.run({ dryRun: true });
    expect(dry.candidates.find((c) => c.table === 'phases' && c.id === 15)).toMatchObject({
      action: 'deactivate',
      mergeInto: { id: 14 },
    });

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
          { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null },
          { table: 'phases', id: 15, action: 'deactivate', mergeInto: 14 },
        ],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: 'SERVICE_PHASE_CLEANUP_PLAN_CHANGED',
      details: {
        mismatches: [
          {
            table: 'phases',
            id: 15,
            approved: { action: 'deactivate', mergeInto: 14 },
            planned: { action: 'merge', mergeInto: 14 },
          },
        ],
      },
    });
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.phases.find((p) => p.id === 2)).toMatchObject({ kind: 'service' }); // not even the matching row
  });

  it('409 and nothing written when an approved service_types row now plans another action', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    const dry = await svc.run({ dryRun: true });
    expect(dry.candidates.find((c) => c.table === 'service_types' && c.id === 16)).toMatchObject({
      action: 'deactivate',
      mergeInto: { id: 15 },
    });

    // After the review, a task starts using "Structural Structural".
    db.tasks.push({ id: 9, phaseId: null, serviceTypeId: 16, projectId: 100, deletedAt: null });
    const err = await svc
      .run({
        dryRun: false,
        approved: [
          { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null },
          { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
          { table: 'service_types', id: 16, action: 'deactivate', mergeInto: 15 },
        ],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'SERVICE_PHASE_CLEANUP_PLAN_CHANGED' });
    expect(err.getResponse().details.mismatches).toEqual([
      {
        table: 'service_types',
        id: 16,
        approved: { action: 'deactivate', mergeInto: 15 },
        planned: { action: 'merge', mergeInto: 15 },
      },
    ]);
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.serviceTypes.find((st) => st.id === 14)!.isActive).toBe(true);
    expect(db.tasks.find((t) => t.id === 3)!.serviceTypeId).toBe(14);
  });

  it('409 when an approved merge target is not the planned one', async () => {
    const db = seedDb();
    const { prisma, writes } = makePrisma(db);
    const err = await new Qa6ServicePhaseCleanupService(prisma)
      .run({
        dryRun: false,
        approved: [
          { table: 'phases', id: 11, action: 'merge', mergeInto: 13 },
          { table: 'service_types', id: 14, action: 'merge', mergeInto: 1 },
        ],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().details.mismatches).toEqual([
      { table: 'phases', id: 11, approved: { action: 'merge', mergeInto: 13 }, planned: { action: 'merge', mergeInto: 10 } },
      {
        table: 'service_types',
        id: 14,
        approved: { action: 'merge', mergeInto: 1 },
        planned: { action: 'merge', mergeInto: 13 },
      },
    ]);
    expect(writes).toEqual([]);
  });

  it('a dry-run with the approved list runs the same check, so it tells whether the real run would pass', async () => {
    const { prisma } = makePrisma(seedDb());
    const svc = new Qa6ServicePhaseCleanupService(prisma);
    await expect(
      svc.run({ dryRun: true, approved: [{ table: 'phases', id: 11, action: 'deactivate', mergeInto: 10 }] }),
    ).rejects.toBeInstanceOf(ConflictException);
    const ok = await svc.run({ dryRun: true, approved: [{ table: 'phases', id: 11, action: 'merge', mergeInto: 10 }] });
    expect(ok.applied).toBeNull();
    expect(ok.approved).toEqual([{ table: 'phases', id: 11, action: 'merge', mergeInto: 10 }]);
  });

  it('staging today: phases #17 into #7 and service_types #14 into #13 with the owner body, then nothing left to plan', async () => {
    const db: Db = {
      phases: [
        row(1, 'Pre-Design', { kind: 'phase' }), // marked by the first run
        row(7, 'BIM Coordination', { code: 'BMC' }),
        row(17, 'BIM Coordination BIM'),
        row(20, 'BIM Management Basic'),
        row(21, 'VDC Quantity'),
        row(22, 'CAD Cooreination'),
      ],
      serviceTypes: [
        { id: 13, name: 'BIM Coordination', code: null, isActive: true },
        { id: 14, name: 'BIM Coordination BIM', code: null, isActive: true },
      ],
      tasks: [
        { id: 1, phaseId: 17, serviceTypeId: 14, projectId: 100, deletedAt: null },
        { id: 2, phaseId: 7, serviceTypeId: 13, projectId: 100, deletedAt: null },
      ],
      templates: [],
      templateTasks: [],
      templateZoneTasks: [],
      projectDeliverables: [],
      zoneServiceTypes: [{ id: 1, zoneId: 500, serviceTypeId: 14 }],
      projectCategories: [],
    };
    const { prisma } = makePrisma(db);
    const svc = new Qa6ServicePhaseCleanupService(prisma);

    const dry = await svc.run(parseServicePhaseCleanupBody(undefined));
    expect(asApproved(dry.candidates)).toEqual([
      { table: 'phases', id: 17, action: 'merge', mergeInto: 7 },
      { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
    ]);

    const ownerBody = {
      dryRun: false,
      approved: [
        { table: 'phases', id: 17, action: 'merge', mergeInto: 7 },
        { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
      ],
    };
    const res = await svc.run(parseServicePhaseCleanupBody(ownerBody));
    expect(res.applied!.map((a) => [a.table, a.id, a.action, a.mergeInto])).toEqual([
      ['phases', 17, 'merge', 7],
      ['service_types', 14, 'merge', 13],
    ]);
    expect(db.tasks.find((t) => t.id === 1)).toMatchObject({ phaseId: 7, serviceTypeId: 13 });
    expect(db.zoneServiceTypes).toEqual([{ id: 1, zoneId: 500, serviceTypeId: 13 }]);
    expect(db.phases.find((p) => p.id === 17)!.isActive).toBe(false);
    expect(db.serviceTypes.find((st) => st.id === 14)!.isActive).toBe(false);

    expect((await svc.run({ dryRun: true })).candidates).toEqual([]);
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
    await controller.runQa6ServicePhaseCleanup({ id: 7 }, {
      dryRun: false,
      approved: [
        { id: 2, action: 'mark_phase' },
        { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
      ],
    });
    expect(service.run).toHaveBeenLastCalledWith({
      dryRun: false,
      approved: [
        { table: 'phases', id: 2, action: 'mark_phase', mergeInto: null },
        { table: 'service_types', id: 14, action: 'merge', mergeInto: 13 },
      ],
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

  it('GET /service-types lists active rows only: a merged or retired row is kept but left out', async () => {
    const rows = [
      { id: 13, name: 'BIM Coordination', isActive: true },
      { id: 14, name: 'BIM Coordination BIM', isActive: false },
    ];
    const prisma: any = {
      serviceType: {
        findMany: jest.fn(async ({ where }: any) => rows.filter((r) => where?.isActive === undefined || r.isActive === where.isActive)),
      },
    };
    const list = await new ServiceTypesService(prisma).findAll();
    expect(prisma.serviceType.findMany).toHaveBeenCalledWith({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    expect(list.map((r: any) => r.id)).toEqual([13]);
  });
});
