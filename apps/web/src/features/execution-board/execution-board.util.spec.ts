import {
  getTaskPhaseName,
  buildZoneDescendants,
  buildTaskMatrix,
  aggregateCellTasks,
  computePhaseColumns,
} from './execution-board.util';

describe('getTaskPhaseName', () => {
  it('prefers serviceType.name', () => {
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
