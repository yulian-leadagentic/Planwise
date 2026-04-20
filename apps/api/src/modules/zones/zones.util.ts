/**
 * Pure helpers for zones/template operations — kept separate so they can be
 * unit-tested without spinning up the full NestJS DI container.
 */

export interface CatalogEntry {
  hours: any;
  amount: any;
}

export interface TemplateTaskLike {
  code?: string | null;
  defaultBudgetHours?: any;
  defaultBudgetAmount?: any;
}

/**
 * Resolves the final budget values for a task created from a template.
 * Priority: template-task's own value → catalog fallback by code → null.
 */
export function resolveBudget(
  tt: TemplateTaskLike,
  catalog: Map<string, CatalogEntry>,
): { budgetHours: any; budgetAmount: any } {
  const fallback = tt.code ? catalog.get(tt.code) : undefined;
  return {
    budgetHours: tt.defaultBudgetHours ?? fallback?.hours ?? null,
    budgetAmount: tt.defaultBudgetAmount ?? fallback?.amount ?? null,
  };
}

/**
 * Builds a lookup map from a list of catalog template tasks.
 * Tasks without a `code` are skipped (they can't be matched later anyway).
 */
export function buildCatalogMap(
  tasks: { code?: string | null; defaultBudgetHours?: any; defaultBudgetAmount?: any }[],
): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const t of tasks) {
    if (t.code) {
      map.set(t.code, { hours: t.defaultBudgetHours, amount: t.defaultBudgetAmount });
    }
  }
  return map;
}
