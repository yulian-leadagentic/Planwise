import {
  getTaskPhaseName,
  getTaskServiceName,
  buildZoneDescendants,
  buildTaskMatrix,
  aggregateCellTasks,
  computePhaseColumns,
} from './execution-board.util';

describe('getTaskPhaseName', () => {
  it('prefers projectDeliverable.name over everything (the project-owned label)', () => {
    expect(
      getTaskPhaseName({
        id: 1,
        zoneId: 1,
        projectDeliverable: { name: 'Critical Report 2' },
        deliverableTemplate: { name: 'Critical Report' },
        serviceType: { name: 'Design' },
        description: '[SERVICE:Other]',
        phase: { name: 'Phase X' },
      }),
    ).toBe('Critical Report 2');
  });

  it('prefers deliverableTemplate.name when no projectDeliverable (matches the task table)', () => {
    expect(
      getTaskPhaseName({
        id: 1,
        zoneId: 1,
        deliverableTemplate: { name: 'Critical Report' },
        serviceType: { name: 'Design' },
        description: '[SERVICE:Other]',
        phase: { name: 'Phase X' },
      }),
    ).toBe('Critical Report');
  });

  it('prefers serviceType.name when no deliverableTemplate', () => {
    expect(getTaskPhaseName({ id: 1, zoneId: 1, serviceType: { name: 'Design' }, description: '[SERVICE:Other]' })).toBe('Design');
  });

  it('falls back to [SERVICE:...] marker in description', () => {
    expect(getTaskPhaseName({ id: 1, zoneId: 1, description: '[SERVICE:Construction]' })).toBe('Construction');
  });

  it('returns null when neither source has a value', () => {
    expect(getTaskPhaseName({ id: 1, zoneId: 1, description: 'just a regular note' })).toBeNull();
    expect(getTaskPhaseName({ id: 1, zoneId: 1 })).toBeNull();
  });

  it('matches only the strict full-string [SERVICE:...] form', () => {
    expect(getTaskPhaseName({ id: 1, zoneId: 1, description: 'hi [SERVICE:X]' })).toBeNull();
  });
});

describe('getTaskServiceName', () => {
  it('prefers the project deliverable\'s service (the authoritative link)', () => {
    expect(
      getTaskServiceName({
        id: 1,
        zoneId: 1,
        projectDeliverable: { name: 'Critical Report', service: { name: 'BIM Coordination' } },
        phase: { name: 'Other Phase' },
      }),
    ).toBe('BIM Coordination');
  });

  it('falls back to deliverableTemplate.phase.name when the project-deliverable has no service link', () => {
    // Regression for: zoned tasks with an ad-hoc projectDeliverable (no service)
    // were silently excluded from the Service filter. Catalog templates carry
    // a phase, so we use that as the fallback before reaching task.phase.
    expect(
      getTaskServiceName({
        id: 1,
        zoneId: 1,
        projectDeliverable: { name: 'Critical Report', service: null },
        deliverableTemplate: { name: 'Critical Report', phase: { name: 'BIM Coordination' } },
        phase: { name: 'Other Phase' },
      }),
    ).toBe('BIM Coordination');
  });

  it('falls back to task.phase.name', () => {
    expect(
      getTaskServiceName({ id: 1, zoneId: 1, phase: { name: 'BIM Management' } }),
    ).toBe('BIM Management');
  });

  it('falls back to legacy serviceType', () => {
    expect(
      getTaskServiceName({ id: 1, zoneId: 1, serviceType: { name: 'Modeling' } }),
    ).toBe('Modeling');
  });

  it('returns null when no service signal is present', () => {
    expect(getTaskServiceName({ id: 1, zoneId: 1 })).toBeNull();
  });

  it('falls back to deliverable-name → service map when task has no FK chain', () => {
    // Mirrors the real-world case: a project-owned deliverable named "דוח קריטי"
    // was created without an explicit service link. The column header badge
    // shows "BIM Coordination" because the matching catalog template carries
    // that phase. Without the map argument the filter ignores it; with it,
    // the task resolves correctly so the filter dropdown lists it.
    const map = new Map([
      ['דוח קריטי', 'BIM Coordination'],
      ['התנעה', 'BIM Management'],
    ]);
    expect(
      getTaskServiceName(
        { id: 1, zoneId: 1, projectDeliverable: { name: 'דוח קריטי' } },
        map,
      ),
    ).toBe('BIM Coordination');
  });

  it('FK chain wins over deliverable-name map', () => {
    const map = new Map([['Critical Report', 'BIM Coordination']]);
    // Task's own service link should always beat the name-based fallback,
    // so an explicit override (the source of truth post-refactor) is honored.
    expect(
      getTaskServiceName(
        {
          id: 1,
          zoneId: 1,
          projectDeliverable: { name: 'Critical Report', service: { name: 'Override' } },
        },
        map,
      ),
    ).toBe('Override');
  });
});

describe('buildZoneDescendants', () => {
  it('returns self-only for leaf zones', () => {
    const map = buildZoneDescendants({ 1: [{ id: 10, children: [] }] });
    expect(map.get(10)).toEqual([10]);
  });

  it('includes all descendants transitively', () => {
    const zones = {
      1: [
        {
          id: 1,
          children: [
            {
              id: 2,
              children: [
                { id: 3, children: [] },
                { id: 4, children: [] },
              ],
            },
            { id: 5, children: [] },
          ],
        },
      ],
    };
    const map = buildZoneDescendants(zones);
    expect([...(map.get(1) ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...(map.get(2) ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(map.get(5)).toEqual([5]);
  });

  it('handles multiple projects independently', () => {
    const zones = {
      1: [{ id: 10, children: [{ id: 11, children: [] }] }],
      2: [{ id: 20, children: [] }],
    };
    const map = buildZoneDescendants(zones);
    expect(map.get(10)).toContain(11);
    expect(map.get(20)).toEqual([20]);
    expect(map.get(11)).toEqual([11]);
  });
});

describe('buildTaskMatrix', () => {
  it('groups tasks by zone × phase name', () => {
    const matrix = buildTaskMatrix([
      { id: 1, zoneId: 10, serviceType: { name: 'Design' } },
      { id: 2, zoneId: 10, serviceType: { name: 'Design' } },
      { id: 3, zoneId: 10, serviceType: { name: 'Build' } },
      { id: 4, zoneId: 20, serviceType: { name: 'Design' } },
    ]);

    expect(matrix.get('10|Design')).toHaveLength(2);
    expect(matrix.get('10|Build')).toHaveLength(1);
    expect(matrix.get('20|Design')).toHaveLength(1);
  });

  it('places phaseless tasks under "__none__"', () => {
    const matrix = buildTaskMatrix([
      { id: 1, zoneId: 10, description: null },
      { id: 2, zoneId: 10, description: 'no marker' },
    ]);
    expect(matrix.get('10|__none__')).toHaveLength(2);
  });
});

describe('aggregateCellTasks', () => {
  it('pulls tasks from the zone + all descendants', () => {
    const descendants = new Map<number, number[]>([
      [1, [1, 2, 3]],
      [2, [2]],
      [3, [3]],
    ]);
    const matrix = new Map<string, any[]>([
      ['1|Design', [{ id: 'a' }]],
      ['2|Design', [{ id: 'b' }]],
      ['3|Design', [{ id: 'c' }]],
      ['3|Build', [{ id: 'd' }]],
    ]);
    expect(aggregateCellTasks(1, 'Design', descendants, matrix)).toHaveLength(3);
    expect(aggregateCellTasks(2, 'Design', descendants, matrix)).toHaveLength(1);
    expect(aggregateCellTasks(1, 'Build', descendants, matrix)).toHaveLength(1);
  });

  it('falls back to [zoneId] when descendants map has no entry', () => {
    const matrix = new Map<string, any[]>([
      ['99|X', [{ id: 'only-self' }]],
    ]);
    expect(aggregateCellTasks(99, 'X', new Map(), matrix)).toHaveLength(1);
  });
});

describe('computePhaseColumns', () => {
  const tasks = [
    { id: 1, zoneId: 1, serviceType: { name: 'Design' } },
    { id: 2, zoneId: 1, description: '[SERVICE:Permits]' },
    { id: 3, zoneId: 1 }, // no phase
    { id: 4, zoneId: 1, serviceType: { name: 'Custom' } },
  ];

  it('orders known phases by template-defined order', () => {
    const { columns } = computePhaseColumns(tasks, ['Permits', 'Design', 'Build']);
    // Only present phases appear; "Build" was in templates but no tasks use it
    expect(columns).toEqual(['Permits', 'Design', 'Custom']);
  });

  it('appends tasks-only phases after template phases', () => {
    const { columns } = computePhaseColumns(tasks, ['Design']);
    expect(columns[0]).toBe('Design');
    expect(columns).toContain('Permits');
    expect(columns).toContain('Custom');
  });

  it('sets hasNoPhase when any task is missing a phase', () => {
    const { hasNoPhase } = computePhaseColumns(tasks, []);
    expect(hasNoPhase).toBe(true);
  });

  it('reports hasNoPhase: false when every task has a phase', () => {
    const { hasNoPhase } = computePhaseColumns(
      [{ id: 1, zoneId: 1, serviceType: { name: 'X' } }],
      [],
    );
    expect(hasNoPhase).toBe(false);
  });
});
