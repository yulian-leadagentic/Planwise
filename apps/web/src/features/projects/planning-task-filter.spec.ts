import { describe, it, expect } from 'vitest';
import {
  EMPTY_BUCKET,
  PLANNING_FILTERS_DEFAULT,
  type PlanningTabFilters,
  resolveTaskService,
  serviceFilterOptions,
  taskPassesColFilter,
  taskPassesPlanningFilters,
  taskServiceFilterValue,
} from './planning-task-filter';
import {
  resolveTaskDeliverable,
  type ProjectDeliverableLookups,
} from '@/features/planning/resolve-task-deliverable';

// ─── Fixture: one project, two zones + root, two services ──────────────────
//
// The Service of a task can come from different places (see
// resolveTaskService); the fixture covers each path so the filter is
// proven to match what the SERVICE column shows, not just task.phase.

const BIM = { id: 1, name: 'BIM Coordination', color: '#2563EB' };
const DESIGN = { id: 2, name: 'Design', color: '#16A34A' };

const deliverables = [
  { id: 10, name: 'Clash report', sourceTemplateId: 100, service: BIM },
  { id: 20, name: 'Concept set', sourceTemplateId: 200, service: DESIGN },
];
const lookups: ProjectDeliverableLookups = {
  list: deliverables,
  byId: new Map(deliverables.map((d) => [d.id, d])),
  byTemplateId: new Map(deliverables.map((d) => [d.sourceTemplateId, d])),
};

const tasks = [
  // Server-resolved service (planning payload `service`).
  { id: 1, code: 'B1', name: 'Clash run', zoneId: 1, zone: { name: 'Basement' }, phaseId: 1, phase: BIM, service: BIM, projectDeliverableId: 10, status: 'in_progress' },
  // Service only via the direct phase FK.
  { id: 2, code: 'B2', name: 'Model check', zoneId: 2, zone: { name: 'Level 1' }, phaseId: 1, phase: BIM, projectDeliverableId: 10, status: 'not_started' },
  // phaseId NULL; service only via the project deliverable lookup.
  { id: 3, code: 'B3', name: 'Coordination meeting', zoneId: null, zone: null, phaseId: null, projectDeliverableId: 10, status: 'completed' },
  // Design tasks in the same zones / root.
  { id: 4, code: 'D1', name: 'Massing', zoneId: 1, zone: { name: 'Basement' }, phaseId: 2, phase: DESIGN, service: DESIGN, projectDeliverableId: 20, status: 'in_progress' },
  { id: 5, code: 'D2', name: 'Facade study', zoneId: null, zone: null, phaseId: null, deliverableTemplateId: 200, status: 'not_started' },
  // No service anywhere.
  { id: 6, code: 'X1', name: 'Kickoff', zoneId: 2, zone: { name: 'Level 1' }, phaseId: null, status: 'not_started' },
];

const withFilters = (patch: Partial<PlanningTabFilters> & { service?: string } = {}): PlanningTabFilters => {
  const { service, ...rest } = patch;
  return {
    ...PLANNING_FILTERS_DEFAULT,
    ...rest,
    col: { ...PLANNING_FILTERS_DEFAULT.col, ...(rest.col ?? {}), ...(service !== undefined ? { service } : {}) },
  };
};

const run = (f: PlanningTabFilters, search = '') =>
  tasks.filter((t) => taskPassesPlanningFilters(t, f, search, lookups));
const ids = (list: { id: number }[]) => list.map((t) => t.id).sort((a, b) => a - b);

// ─── Grouping keys, mirroring PlanningView ─────────────────────────────────
// Zone: one card per zone + the Project Root card.
// Deliverable: resolveTaskDeliverable (same label as the group headers).
// Service: the Service grouping buckets by task.phaseId ("No Service" else).
// None: a single "All Tasks" card.
type KeyFn = (t: any) => string;
const GROUPINGS: Record<string, KeyFn[]> = {
  zone: [(t) => String(t.zoneId ?? 'root')],
  deliverable: [(t) => resolveTaskDeliverable(t, lookups)],
  service: [(t) => String(t.phaseId ?? 'none')],
  none: [() => 'all'],
  'zone > deliverable > service': [
    (t) => String(t.zoneId ?? 'root'),
    (t) => resolveTaskDeliverable(t, lookups),
    (t) => String(t.phaseId ?? 'none'),
  ],
};
const groupBy = (list: any[], keys: KeyFn[]): Map<string, number[]> => {
  const m = new Map<string, number[]>();
  for (const t of list) {
    const k = keys.map((fn) => fn(t)).join(' / ');
    m.set(k, [...(m.get(k) ?? []), t.id]);
  }
  return m;
};

describe('resolveTaskService (the SERVICE column resolver)', () => {
  it('walks server service → phase → deliverable relations → lookups', () => {
    expect(resolveTaskService({ service: BIM, phase: DESIGN }).name).toBe('BIM Coordination');
    expect(resolveTaskService({ phase: DESIGN }).name).toBe('Design');
    expect(resolveTaskService({ projectDeliverable: { service: BIM } }).name).toBe('BIM Coordination');
    expect(resolveTaskService({ deliverableTemplate: { phase: DESIGN } }).name).toBe('Design');
    expect(resolveTaskService({ projectDeliverableId: 10 }, lookups).name).toBe('BIM Coordination');
    expect(resolveTaskService({ deliverableTemplateId: 200 }, lookups).name).toBe('Design');
    expect(resolveTaskService({}, lookups)).toEqual({ name: null, color: null });
  });

  it('maps "nothing resolved" to the (empty) bucket for filtering', () => {
    expect(taskServiceFilterValue({}, lookups)).toBe(EMPTY_BUCKET);
    expect(taskServiceFilterValue(tasks[2], lookups)).toBe('BIM Coordination');
  });
});

describe('serviceFilterOptions', () => {
  it('lists every service shown in the grid once, sorted, plus (empty)', () => {
    expect(serviceFilterOptions(tasks, lookups)).toEqual([EMPTY_BUCKET, 'BIM Coordination', 'Design']);
  });

  it('omits (empty) when every task has a service', () => {
    expect(serviceFilterOptions(tasks.slice(0, 5), lookups)).toEqual(['BIM Coordination', 'Design']);
  });
});

describe('Service filter (PR-068)', () => {
  it('no Service filter keeps every task', () => {
    expect(ids(run(withFilters()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('"BIM Coordination" keeps only BIM tasks, whichever path resolves the service', () => {
    expect(ids(run(withFilters({ service: 'BIM Coordination' })))).toEqual([1, 2, 3]);
  });

  it('"Design" keeps only Design tasks (incl. a deliverable-template-only task)', () => {
    expect(ids(run(withFilters({ service: 'Design' })))).toEqual([4, 5]);
  });

  it('(empty) keeps only tasks with no resolvable service', () => {
    expect(ids(run(withFilters({ service: EMPTY_BUCKET })))).toEqual([6]);
  });

  it('a service no task has yields no rows (stale persisted value)', () => {
    expect(run(withFilters({ service: 'Gone Service' }))).toEqual([]);
  });

  it('ANDs with the other Task Filters and with search', () => {
    expect(ids(run(withFilters({ service: 'BIM Coordination', status: 'not_started' })))).toEqual([2]);
    expect(ids(run(withFilters({ service: 'BIM Coordination' }), 'meeting'))).toEqual([3]);
    expect(ids(run(withFilters({ service: 'Design', col: { ...PLANNING_FILTERS_DEFAULT.col, zone: 'Basement' } })))).toEqual([4]);
  });

  it('is the same value the Service column funnel applies', () => {
    for (const t of tasks) {
      expect(taskPassesColFilter(t, 'service', 'BIM Coordination', lookups))
        .toBe(taskPassesPlanningFilters(t, withFilters({ service: 'BIM Coordination' }), '', lookups));
    }
  });

  it('survives the localStorage round-trip it is persisted through', () => {
    const persisted = JSON.parse(JSON.stringify(withFilters({ service: 'BIM Coordination' }))) as PlanningTabFilters;
    expect(ids(run(persisted))).toEqual([1, 2, 3]);
  });
});

describe('Service filter × grouping modes', () => {
  const svc = 'BIM Coordination';
  const filtered = run(withFilters({ service: svc }));
  const isBim = (id: number) => taskServiceFilterValue(tasks.find((t) => t.id === id), lookups) === svc;

  for (const [mode, keys] of Object.entries(GROUPINGS)) {
    it(`${mode}: every card holds only ${svc} tasks`, () => {
      const groups = groupBy(filtered, keys);
      expect(groups.size).toBeGreaterThan(0);
      for (const members of groups.values()) {
        expect(members.every(isBim)).toBe(true);
      }
    });

    it(`${mode}: filtering then grouping = grouping with other services removed`, () => {
      // The grid filters ONCE before grouping. So each card is exactly
      // the unfiltered card minus the other services' tasks, and a card
      // left with no tasks is not built at all (same as Status/Assignee).
      const expected = new Map<string, number[]>();
      for (const [k, members] of groupBy(tasks, keys)) {
        const kept = members.filter(isBim);
        if (kept.length > 0) expected.set(k, kept);
      }
      expect(groupBy(filtered, keys)).toEqual(expected);
    });
  }

  it('Zone grouping: the Level 1 card keeps only its BIM task; Design-only cards vanish', () => {
    const byZone = groupBy(filtered, GROUPINGS.zone);
    expect(byZone.get('1')).toEqual([1]); // Basement: B1 kept, D1 hidden
    expect(byZone.get('2')).toEqual([2]); // Level 1: B2 kept, X1 hidden
    expect(byZone.get('root')).toEqual([3]); // Project Root: B3 kept, D2 hidden
  });

  it('Deliverable grouping: the Design deliverable card disappears', () => {
    const byDeliv = groupBy(filtered, GROUPINGS.deliverable);
    expect(Array.from(byDeliv.keys())).toEqual(['Clash report']);
  });
});

describe('column predicate shared with the cascading option lists', () => {
  it('Deliverable "(empty)" matches tasks that resolve to No Deliverable', () => {
    const noDeliv = { id: 99, name: 'x' };
    expect(taskPassesColFilter(noDeliv, 'deliverable', EMPTY_BUCKET, lookups)).toBe(true);
    expect(taskPassesColFilter(tasks[0], 'deliverable', EMPTY_BUCKET, lookups)).toBe(false);
  });

  it('empty value always passes', () => {
    expect(taskPassesColFilter(tasks[0], 'service', '', lookups)).toBe(true);
  });
});
