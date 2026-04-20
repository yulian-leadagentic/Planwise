import { buildCatalogMap, resolveBudget } from './zones.util';

describe('zones.util', () => {
  describe('buildCatalogMap', () => {
    it('returns an empty map when no tasks are given', () => {
      expect(buildCatalogMap([])).toEqual(new Map());
    });

    it('indexes tasks by code, ignoring tasks without a code', () => {
      const map = buildCatalogMap([
        { code: 'A', defaultBudgetHours: 10, defaultBudgetAmount: 1000 },
        { code: null, defaultBudgetHours: 5 }, // skipped — no code to match on
        { code: 'B', defaultBudgetHours: 20, defaultBudgetAmount: null },
      ]);

      expect(map.size).toBe(2);
      expect(map.get('A')).toEqual({ hours: 10, amount: 1000 });
      expect(map.get('B')).toEqual({ hours: 20, amount: null });
    });

    it('keeps the last occurrence when duplicate codes appear', () => {
      const map = buildCatalogMap([
        { code: 'X', defaultBudgetHours: 1 },
        { code: 'X', defaultBudgetHours: 2 },
      ]);
      expect(map.get('X')?.hours).toBe(2);
    });
  });

  describe('resolveBudget', () => {
    const catalog = buildCatalogMap([
      { code: 'TASK_A', defaultBudgetHours: 8, defaultBudgetAmount: 500 },
      { code: 'TASK_B', defaultBudgetHours: 0, defaultBudgetAmount: 0 },
    ]);

    it('prefers the template task\'s own values when set', () => {
      expect(
        resolveBudget({ code: 'TASK_A', defaultBudgetHours: 16, defaultBudgetAmount: 999 }, catalog),
      ).toEqual({ budgetHours: 16, budgetAmount: 999 });
    });

    it('falls back to the catalog when the template task has no values', () => {
      expect(resolveBudget({ code: 'TASK_A' }, catalog)).toEqual({ budgetHours: 8, budgetAmount: 500 });
    });

    it('falls back field-by-field (hours from template, amount from catalog)', () => {
      expect(
        resolveBudget({ code: 'TASK_A', defaultBudgetHours: 12 }, catalog),
      ).toEqual({ budgetHours: 12, budgetAmount: 500 });
    });

    it('returns null when neither has a value', () => {
      expect(resolveBudget({ code: 'UNKNOWN' }, catalog)).toEqual({
        budgetHours: null,
        budgetAmount: null,
      });
    });

    it('does not attempt catalog lookup when code is missing', () => {
      expect(resolveBudget({ defaultBudgetHours: 3 }, catalog)).toEqual({
        budgetHours: 3,
        budgetAmount: null,
      });
    });

    it('treats explicit 0 as a real value (not falsy)', () => {
      // TASK_B has 0 hours/amount in the catalog. A template-task with null
      // should fall back to 0, not skip to null. This is the ?? vs || difference.
      expect(resolveBudget({ code: 'TASK_B' }, catalog)).toEqual({
        budgetHours: 0,
        budgetAmount: 0,
      });
    });
  });
});
