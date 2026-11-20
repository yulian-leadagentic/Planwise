/**
 * Finance visibility — the one place that documents which response
 * fields are money and who may see / change them (permissions round 2,
 * 2026-11-20).
 *
 * Owner rule:
 *   • `finance:read` is the ONLY thing that lets a user see ANY money
 *     value. Enforced on the SERVER: a caller without it must not get
 *     the value in the JSON at all (hiding it in the UI does not count).
 *   • Changing a money value needs `finance:write`; approving / moving a
 *     billing's status needs `finance:approve`.
 *   • `finance` is in the RolesGuard's NO_ADMIN_BYPASS set — an Admin
 *     needs the explicit grant like everyone else. Never use
 *     `isAdminUser` here.
 *   • Hours (`budgetHours`, `loggedMinutes`, durations) are NOT money and
 *     stay visible.
 *
 * Read side, three layers:
 *   1. `FinanceRedactionInterceptor` (global) runs `redactFinanceFields`
 *      over every JSON response of a caller without `finance:read`. It
 *      removes the UNAMBIGUOUS keys in `FINANCE_REDACTED_KEYS` at any
 *      depth, plus the parent-scoped keys in `FINANCE_SCOPED_KEYS`.
 *   2. Names that are money in one place and something else in another
 *      (`amount`, `total`, `quantity`, `budget`, `cost`, `remaining`, …)
 *      are NOT in the global list — the endpoints that return them as
 *      money strip them explicitly (`omitKeys` + the per-endpoint key
 *      lists below).
 *   3. File exports bypass interceptors entirely, so each export drops
 *      its money columns itself (reports export, project tasks export).
 *
 * Write side: `assertFinanceFieldWrites` — a money key sent with a value
 * DIFFERENT from the stored one (or a non-empty value on create) needs
 * `finance:write` (or `finance:approve` for billing status). An
 * unchanged value passes, because forms send the whole object back.
 * Server-internal writes (template apply copying catalog budgets,
 * materializers, importers gated by `canSeeFinance`) are not user input
 * and do not go through this.
 */
import {
  PermissionDeniedException,
  describePermission,
  joinLabels,
  permissionDenied,
  prettifyFieldName,
} from '../errors/permission-denied';
import { userHasModulePermission } from '../guards/roles.guard';

// ─── Who ────────────────────────────────────────────────────────────

/** May see money values. No user (public route) → false. */
export function canSeeFinance(user: any): boolean {
  return !!user && userHasModulePermission(user, 'finance', 'read');
}

/** May change money values. */
export function canWriteFinance(user: any): boolean {
  return !!user && userHasModulePermission(user, 'finance', 'write');
}

/** May approve / move a billing's status. */
export function canApproveFinance(user: any): boolean {
  return !!user && userHasModulePermission(user, 'finance', 'approve');
}

/**
 * 403 unless the caller holds `finance:<action>`. For routes whose main
 * gate stays on `@RequirePermissions` (e.g. `admin:read`): putting
 * `finance` into the same decorator would switch the guard's Admin
 * bypass off for the OTHER module too (entries are ANDed and the bypass
 * only applies when no entry is in NO_ADMIN_BYPASS), so the finance half
 * is checked here, by hand.
 */
export function assertFinanceAccess(user: any, action: 'read' | 'write' | 'approve'): void {
  const ok =
    action === 'read' ? canSeeFinance(user) : action === 'write' ? canWriteFinance(user) : canApproveFinance(user);
  // "You don't have permission to view financial data. Ask your administrator for access."
  if (!ok) throw permissionDenied('finance', action);
}

// ─── Read side: the global key list ─────────────────────────────────

/**
 * Keys removed at ANY depth from the response of a caller without
 * `finance:read`. Each one was checked against the Prisma schema and
 * every API service / DTO: it is never used for a non-money value in a
 * response. Do NOT add generic names (`amount`, `total`, `quantity`,
 * `budget`, `cost`, `remaining`, `currency`): HR / time / attendance use
 * `amount` / `total` for days, hours and pagination counts.
 *
 *   budgetAmount         Task.budgetAmount (+ planning rows, activity-log changes)
 *   defaultBudgetAmount  TemplateTask / TemplateZoneTask price list
 *   estimatedValue       Project.estimatedValue
 *   salaryHourly         User.salaryHourly (also data-import before/after JSON)
 *   monthlySalary        Term.monthlySalary
 *   hourlyRate           TaskAssignee.hourlyRate, Term.hourlyRate
 *   hourlyCost           SeniorityRate / UserRate / labor-cost rows
 *   defaultHourlyCost    SeniorityLevel.defaultHourlyCost (users list, seniorities)
 *   effectiveHourlyCost  computed (users list, seniority levels)
 *   rateSource           computed — marks people with a personal rate override
 *   actualCost           computed labor cost (projects, planning tasks)
 *   actualCostCurrency   currency tag of actualCost (planning tasks)
 *   estimatedCost        computed (cost reports)
 *   totalCost            computed (labor cost, timesheet per-currency totals)
 *   totalAmount          Contract.totalAmount, planning budgetSummary.totalAmount
 *   unitPrice            ContractItem.unitPrice
 *   projectBudget        planning budgetSummary.projectBudget
 */
export const FINANCE_REDACTED_KEYS: ReadonlySet<string> = new Set([
  'budgetAmount',
  'defaultBudgetAmount',
  'estimatedValue',
  'salaryHourly',
  'monthlySalary',
  'hourlyRate',
  'hourlyCost',
  'defaultHourlyCost',
  'effectiveHourlyCost',
  'rateSource',
  'actualCost',
  'actualCostCurrency',
  'estimatedCost',
  'totalCost',
  'totalAmount',
  'unitPrice',
  'projectBudget',
]);

/**
 * Parent-scoped keys: removed from an object (or from each element of an
 * array) reached through the given parent key. Defence in depth for the
 * relation includes that carry a whole row with an ambiguous money name
 * (`include: { project: true }` → `project.budget`, `milestones: true`
 * → `milestones[].amount`). Each pair was checked: the parent key only
 * ever holds that model.
 */
export const FINANCE_SCOPED_KEYS: Readonly<Record<string, readonly string[]>> = {
  project: ['budget'], //      Project.budget
  projects: ['budget'],
  milestone: ['amount'], //    LabelMilestone.amount
  milestones: ['amount'],
  billing: ['amount'], //      Billing.amount
  billings: ['amount'],
  expenses: ['amount'], //     Expense.amount
};

// ─── Read side: per-endpoint key lists (ambiguous names) ────────────

/** Project row money (list / detail / create / update / setLeader). */
export const PROJECT_MONEY_KEYS = ['budget', 'estimatedValue', 'actualCost'] as const;
/** `GET /projects/:id/planning-data` → `budgetSummary` money (hours stay). */
export const PLANNING_BUDGET_SUMMARY_MONEY_KEYS = [
  'totalAmount',
  'projectBudget',
  'remaining',
  'remainingPct',
] as const;
/** `GET /dashboard/operations` → projectsAtRisk rows (B-11: all three go together). */
export const OPS_PROJECT_RISK_MONEY_KEYS = ['budget', 'budgetUsed', 'budgetPct'] as const;
/** ContractItem money (unitPrice is global). */
export const CONTRACT_ITEM_MONEY_KEYS = ['unitPrice', 'total', 'quantity'] as const;
/** Billing / LabelMilestone / Expense money. */
export const AMOUNT_KEYS = ['amount'] as const;
/** `GET /reports/timesheet/detailed` row money. */
export const TIMESHEET_ROW_MONEY_KEYS = ['cost', 'currency'] as const;

/**
 * Shallow copy of `value` without `keys`. Works on one object or an
 * array of objects; anything else is returned untouched. Never mutates.
 */
export function omitKeys<T>(value: T, keys: readonly string[]): T {
  if (Array.isArray(value)) return value.map((v) => omitKeys(v, keys)) as any;
  if (!value || typeof value !== 'object' || !isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...(value as any) };
  for (const k of keys) delete out[k];
  return out as T;
}

// ─── Read side: the deep walk ───────────────────────────────────────

/**
 * Return `value` with every finance key removed (see the two key lists
 * above). Copy-on-write: unchanged sub-trees keep their identity and the
 * input is never mutated (service-level caches stay intact for the next
 * finance caller). Only plain objects and arrays are walked — Dates,
 * Buffers, streams, `StreamableFile`, Prisma `Decimal` and other class
 * instances are returned as-is (a Decimal money value is removed at its
 * parent, by key). Boolean values are kept even under a money key: a
 * boolean is never a money value (UI column-visibility maps stored in
 * user preferences use column ids such as `budgetAmount` as keys).
 * Shared sub-trees are redacted once; a cycle is returned untouched at
 * the point it closes (JSON.stringify refuses cycles anyway).
 */
export function redactFinanceFields<T>(value: T): T {
  return walk(value, undefined, new Map(), new Set()) as T;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function walk(
  value: unknown,
  parentKey: string | undefined,
  memo: Map<object, Map<string, unknown>>,
  inProgress: Set<object>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;

  const scoped = parentKey !== undefined ? FINANCE_SCOPED_KEYS[parentKey] : undefined;
  const memoKey = scoped ? (parentKey as string) : '';
  const seen = memo.get(value)?.get(memoKey);
  if (seen !== undefined) return seen;
  if (inProgress.has(value)) return value;
  inProgress.add(value);

  let result: unknown = value;
  if (isArray) {
    const arr = value as unknown[];
    let copy: unknown[] | null = null;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      // Array elements inherit the array's parent key, so
      // `milestones: [{ amount }]` is scoped like `milestone: { amount }`.
      const next = walk(item, parentKey, memo, inProgress);
      if (next !== item) {
        if (!copy) copy = arr.slice();
        copy[i] = next;
      }
    }
    if (copy) result = copy;
  } else {
    const obj = value as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      const isMoneyKey = FINANCE_REDACTED_KEYS.has(key) || (scoped !== undefined && scoped.includes(key));
      if (isMoneyKey && typeof child !== 'boolean') {
        if (!copy) copy = { ...obj };
        delete copy[key];
        continue;
      }
      const next = walk(child, key, memo, inProgress);
      if (next !== child) {
        if (!copy) copy = { ...obj };
        copy[key] = next;
      }
    }
    if (copy) result = copy;
  }

  inProgress.delete(value);
  let perScope = memo.get(value);
  if (!perScope) {
    perScope = new Map();
    memo.set(value, perScope);
  }
  perScope.set(memoKey, result);
  return result;
}

// ─── Write side ─────────────────────────────────────────────────────

/** null / undefined / '' are "no value". */
function normalizeMoney(v: unknown): number | string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return String(v);
  // Prisma Decimal, numeric strings ("1200.00"), anything with toString.
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : s;
}

function sameMoney(a: unknown, b: unknown): boolean {
  const x = normalizeMoney(a);
  const y = normalizeMoney(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 0.005;
  return String(x) === String(y);
}

/**
 * The `fields` that `incoming` would change compared with `existing`.
 * A field counts only when `incoming` carries it with a defined value.
 * `existing` null/undefined means create: every non-empty value is a
 * change (pass the create defaults instead — e.g. `{ status: 'draft' }`
 * — when the column has a default the caller may echo back).
 */
export function findFinanceFieldChanges(
  incoming: Record<string, any> | null | undefined,
  existing: Record<string, any> | null | undefined,
  fields: readonly string[],
): string[] {
  if (!incoming || typeof incoming !== 'object') return [];
  const base = existing ?? {};
  return fields.filter(
    (f) =>
      Object.prototype.hasOwnProperty.call(incoming, f) &&
      incoming[f] !== undefined &&
      !sameMoney(incoming[f], base[f]),
  );
}

export type FinanceWriteAction = 'write' | 'approve';

/**
 * End-user names of the money fields `assertFinanceFieldWrites` guards,
 * written to read after "You can't change …". Unknown keys fall back to
 * a prettified field name — never the raw key.
 */
export const FINANCE_FIELD_LABELS: Readonly<Record<string, string>> = {
  budgetAmount: 'budget amounts',
  defaultBudgetAmount: 'price-list amounts',
  hourlyRate: 'hourly rates',
  salaryHourly: 'salary rates',
  seniorityLevelId: 'the labor category',
  budget: 'the project budget',
  estimatedValue: 'the estimated value',
  totalAmount: 'contract totals',
  amount: 'amounts',
  unitPrice: 'unit prices',
  total: 'item totals',
  quantity: 'quantities',
  // Only BILLING_STATUS_FIELDS (billings.controller) sends `status` here.
  status: 'the billing status',
};

/**
 * "You can't change budget amounts — that needs permission to change
 * financial data. Ask your administrator."
 */
export function financeFieldDeniedMessage(fields: readonly string[], action: FinanceWriteAction = 'write'): string {
  const labels = fields.map((f) => FINANCE_FIELD_LABELS[f] ?? prettifyFieldName(f));
  return `You can't change ${joinLabels(labels)} — that needs permission to ${describePermission('finance', action)}. Ask your administrator.`;
}

/**
 * Throw 403 when the caller lacks `finance:<action>` and `incoming`
 * changes one of `fields`. `existing` is the stored row, a loader for it
 * (only called when actually needed — the caller lacks the grant AND
 * sent one of the fields), or null for a create.
 */
export async function assertFinanceFieldWrites(
  user: any,
  incoming: Record<string, any> | null | undefined,
  fields: readonly string[],
  existing:
    | Record<string, any>
    | null
    | undefined
    | (() => Promise<Record<string, any> | null | undefined>),
  action: FinanceWriteAction = 'write',
): Promise<void> {
  if (!incoming || typeof incoming !== 'object') return;
  const allowed = action === 'approve' ? canApproveFinance(user) : canWriteFinance(user);
  if (allowed) return;
  const sent = fields.filter(
    (f) => Object.prototype.hasOwnProperty.call(incoming, f) && incoming[f] !== undefined,
  );
  if (sent.length === 0) return;
  const row = typeof existing === 'function' ? await existing() : existing;
  const changed = findFinanceFieldChanges(incoming, row, sent);
  if (changed.length > 0) {
    throw new PermissionDeniedException(financeFieldDeniedMessage(changed, action), {
      module: 'finance',
      action,
      field: changed[0],
      ...(changed.length > 1 ? { fields: changed } : {}),
    });
  }
}
