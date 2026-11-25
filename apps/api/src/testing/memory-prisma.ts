/**
 * Test-only in-memory Prisma (QA6, 2026-11-25).
 *
 * The repo has no test-database harness (no `test/` e2e config, no
 * test container), so the integration-style specs run the REAL services
 * (ProjectAccessService, StageTransitionService, TasksService, ...) over
 * this fake. It evaluates the where / select / include shapes those
 * services build, against plain arrays of rows, so a spec reads like a
 * small seeded database instead of a stack of per-call mocks.
 *
 * Supported: findFirst / findUnique(OrThrow) / findMany / count /
 * aggregate / groupBy / create / createMany / update / updateMany /
 * upsert / delete / deleteMany, and $transaction. Where: AND / OR / NOT,
 * equals, in, notIn, not, lt, lte, gt, gte, contains, startsWith,
 * endsWith, relation filters (some / every / none, is / isNot, nested
 * where on a to-one relation) and composite unique keys
 * (`taskId_userId: { taskId, userId }`). The soft-delete middleware is
 * NOT applied: specs pass `deletedAt: null` the way the services do.
 *
 * Excluded from the production build (tsconfig.build.json).
 */

export type Row = Record<string, any>;

/** `rows of model where row[to] === parent[from]`. */
export interface RelationDef {
  model: string;
  from: string;
  to: string;
  many?: boolean;
}

export type Relations = Record<string, Record<string, RelationDef>>;

const OPS = new Set([
  'equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode',
]);

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v != null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !isDecimal(v);

function isDecimal(v: any): boolean {
  return v != null && typeof v === 'object' && typeof v.toNumber === 'function' && typeof v.d !== 'undefined';
}

const cmp = (v: any): any => (v instanceof Date ? v.getTime() : isDecimal(v) ? v.toNumber() : v);

function eq(a: any, b: any): boolean {
  if (a == null || b == null) return a == null && b == null;
  return cmp(a) === cmp(b);
}

function matchScalar(actual: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual == null;
  if (!isPlainObject(cond)) return eq(actual, cond);
  return Object.entries(cond).every(([op, v]) => {
    if (v === undefined) return true;
    switch (op) {
      case 'equals': return eq(actual, v);
      case 'in': return (v as any[]).some((x) => eq(actual, x));
      case 'notIn': return !(v as any[]).some((x) => eq(actual, x));
      case 'not': return isPlainObject(v) ? !matchScalar(actual, v) : !eq(actual, v);
      case 'lt': return actual != null && cmp(actual) < cmp(v);
      case 'lte': return actual != null && cmp(actual) <= cmp(v);
      case 'gt': return actual != null && cmp(actual) > cmp(v);
      case 'gte': return actual != null && cmp(actual) >= cmp(v);
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(v).toLowerCase());
      case 'startsWith': return String(actual ?? '').startsWith(String(v));
      case 'endsWith': return String(actual ?? '').endsWith(String(v));
      case 'mode': return true;
      default: throw new Error(`memory-prisma: unsupported scalar operator "${op}"`);
    }
  });
}

export class MemoryDb {
  readonly tables: Record<string, Row[]> = {};
  private ids: Record<string, number> = {};

  constructor(private relations: Relations, seed: Record<string, Row[]> = {}) {
    for (const [model, rows] of Object.entries(seed)) {
      this.tables[model] = rows.map((r) => ({ ...r }));
      this.ids[model] = Math.max(0, ...this.tables[model].map((r) => Number(r.id) || 0));
    }
  }

  table(model: string): Row[] {
    if (!this.tables[model]) this.tables[model] = [];
    return this.tables[model];
  }

  private rel(model: string, key: string): RelationDef | undefined {
    return this.relations[model]?.[key];
  }

  private related(model: string, row: Row, def: RelationDef): Row[] {
    const v = row[def.from];
    if (v == null) return [];
    return this.table(def.model).filter((r) => eq(r[def.to], v));
  }

  match(model: string, row: Row, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]: [string, any]) => {
      if (cond === undefined) return true;
      if (key === 'AND') return ([] as any[]).concat(cond).every((w) => this.match(model, row, w));
      if (key === 'OR') return (cond as any[]).some((w) => this.match(model, row, w));
      if (key === 'NOT') return !([] as any[]).concat(cond).some((w) => this.match(model, row, w));
      const def = this.rel(model, key);
      if (def) {
        const rows = this.related(model, row, def);
        if (def.many) {
          if (cond.some !== undefined) return rows.some((r) => this.match(def.model, r, cond.some));
          if (cond.every !== undefined) return rows.every((r) => this.match(def.model, r, cond.every));
          if (cond.none !== undefined) return !rows.some((r) => this.match(def.model, r, cond.none));
          throw new Error(`memory-prisma: to-many filter on ${model}.${key} needs some/every/none`);
        }
        const one = rows[0];
        if (cond === null) return one == null;
        if (isPlainObject(cond) && ('is' in cond || 'isNot' in cond)) {
          if ('is' in cond) return cond.is === null ? one == null : !!one && this.match(def.model, one, cond.is);
          return cond.isNot === null ? one != null : !one || !this.match(def.model, one, cond.isNot);
        }
        return !!one && this.match(def.model, one, cond);
      }
      // Composite unique key, e.g. taskId_userId: { taskId, userId }.
      if (key.includes('_') && isPlainObject(cond) && !Object.keys(cond).some((k) => OPS.has(k))) {
        return this.match(model, row, cond);
      }
      return matchScalar(row[key], cond);
    });
  }

  private sort(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;
    const specs = ([] as any[]).concat(orderBy).flatMap((o) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [field, dir] of specs) {
        if (typeof dir !== 'string') continue; // relation orderBy: ignored
        const av = cmp(a[field]);
        const bv = cmp(b[field]);
        if (av === bv) continue;
        if (av == null) return 1;
        if (bv == null) return -1;
        const r = av < bv ? -1 : 1;
        return dir === 'desc' ? -r : r;
      }
      return 0;
    });
  }

  query(model: string, args: any = {}): Row[] {
    let rows = this.table(model).filter((r) => this.match(model, r, args.where));
    rows = this.sort(rows, args.orderBy);
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = (args.distinct as string[]).map((f) => String(r[f])).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const skip = args.skip ?? 0;
    return rows.slice(skip, args.take != null ? skip + args.take : undefined);
  }

  project(model: string, row: Row, args: any = {}): Row {
    const { select, include } = args;
    const out: Row = {};
    if (!select) for (const [k, v] of Object.entries(row)) out[k] = v;
    const spec = select ?? include ?? {};
    for (const [key, val] of Object.entries(spec)) {
      if (!val) continue;
      if (key === '_count') {
        const counts: Row = {};
        for (const [rk, rv] of Object.entries((val as any).select ?? {})) {
          const def = this.rel(model, rk);
          if (!def) { counts[rk] = 0; continue; }
          let rows = this.related(model, row, def);
          if (isPlainObject(rv) && (rv as any).where) rows = rows.filter((r) => this.match(def.model, r, (rv as any).where));
          counts[rk] = rows.length;
        }
        out._count = counts;
        continue;
      }
      const def = this.rel(model, key);
      if (!def) {
        // A relation the spec did not declare: an empty answer, not a crash.
        if (select && val === true) out[key] = row[key];
        else if (!(key in out)) out[key] = Array.isArray(row[key]) ? row[key] : row[key] ?? null;
        continue;
      }
      const nested = isPlainObject(val) ? val : {};
      let rows = this.related(model, row, def).filter((r) => this.match(def.model, r, (nested as any).where));
      if (def.many) {
        rows = this.sort(rows, (nested as any).orderBy);
        if ((nested as any).take != null) rows = rows.slice(0, (nested as any).take);
        out[key] = rows.map((r) => this.project(def.model, r, nested));
      } else {
        out[key] = rows[0] ? this.project(def.model, rows[0], nested) : null;
      }
    }
    return out;
  }

  insert(model: string, data: Row): Row {
    const row: Row = {};
    const nestedCreates: Array<[RelationDef, Row[]]> = [];
    for (const [k, v] of Object.entries(data)) {
      const def = this.rel(model, k);
      if (def && isPlainObject(v)) {
        if (def.many && (v as any).create) nestedCreates.push([def, ([] as Row[]).concat((v as any).create)]);
        if (!def.many && (v as any).connect) row[def.from] = (v as any).connect[def.to];
        continue;
      }
      if (v !== undefined) row[k] = v;
    }
    if (row.id == null) {
      this.ids[model] = (this.ids[model] ?? 0) + 1;
      row.id = this.ids[model];
    } else {
      this.ids[model] = Math.max(this.ids[model] ?? 0, Number(row.id));
    }
    if (row.createdAt === undefined) row.createdAt = new Date();
    if (row.updatedAt === undefined) row.updatedAt = new Date();
    this.table(model).push(row);
    for (const [def, children] of nestedCreates) {
      for (const c of children) this.insert(def.model, { ...c, [def.to]: row[def.from] });
    }
    return row;
  }

  apply(row: Row, data: Row): Row {
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && 'increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if (isPlainObject(v) && 'set' in v) row[k] = (v as any).set;
      else row[k] = v;
    }
    row.updatedAt = new Date();
    return row;
  }
}

/** A PrismaService look-alike over `db`. Every model method is a jest-free async function. */
export function memoryPrisma(db: MemoryDb): any {
  const delegates = new Map<string, any>();
  const delegate = (model: string) => {
    if (delegates.has(model)) return delegates.get(model);
    const d = {
      findMany: async (args: any = {}) => db.query(model, args).map((r) => db.project(model, r, args)),
      findFirst: async (args: any = {}) => {
        const r = db.query(model, { ...args, take: 1 })[0];
        return r ? db.project(model, r, args) : null;
      },
      findUnique: async (args: any) => {
        const r = db.query(model, { where: args.where, take: 1 })[0];
        return r ? db.project(model, r, args) : null;
      },
      findFirstOrThrow: async (args: any = {}) => {
        const r = await d.findFirst(args);
        if (!r) throw new Error(`${model} not found`);
        return r;
      },
      findUniqueOrThrow: async (args: any) => {
        const r = await d.findUnique(args);
        if (!r) throw new Error(`${model} not found`);
        return r;
      },
      count: async (args: any = {}) => db.query(model, { where: args.where }).length,
      create: async (args: any) => db.project(model, db.insert(model, args.data), args),
      createMany: async (args: any) => {
        const rows = ([] as Row[]).concat(args.data);
        for (const r of rows) db.insert(model, r);
        return { count: rows.length };
      },
      update: async (args: any) => {
        const r = db.query(model, { where: args.where, take: 1 })[0];
        if (!r) throw new Error(`${model} to update not found`);
        return db.project(model, db.apply(r, args.data), args);
      },
      updateMany: async (args: any) => {
        const rows = db.query(model, { where: args.where });
        for (const r of rows) db.apply(r, args.data);
        return { count: rows.length };
      },
      upsert: async (args: any) => {
        const r = db.query(model, { where: args.where, take: 1 })[0];
        if (r) return db.project(model, db.apply(r, args.update), args);
        return db.project(model, db.insert(model, args.create), args);
      },
      delete: async (args: any) => {
        const r = db.query(model, { where: args.where, take: 1 })[0];
        if (!r) throw new Error(`${model} to delete not found`);
        db.tables[model] = db.table(model).filter((x) => x !== r);
        return r;
      },
      deleteMany: async (args: any = {}) => {
        const rows = new Set(db.query(model, { where: args.where }));
        db.tables[model] = db.table(model).filter((x) => !rows.has(x));
        return { count: rows.size };
      },
      aggregate: async (args: any = {}) => aggregateRows(db.query(model, { where: args.where }), args),
      groupBy: async (args: any) => {
        const groups = new Map<string, Row[]>();
        for (const r of db.query(model, { where: args.where })) {
          const k = (args.by as string[]).map((f) => String(r[f])).join('|');
          groups.set(k, [...(groups.get(k) ?? []), r]);
        }
        return [...groups.values()].map((rows) => ({
          ...Object.fromEntries((args.by as string[]).map((f) => [f, rows[0][f]])),
          ...aggregateRows(rows, args),
        }));
      },
    };
    delegates.set(model, d);
    return d;
  };

  const client: any = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === 'then') return undefined; // not a thenable
        if (prop === '$transaction') {
          return async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
        }
        if (prop === '__db') return db;
        if (typeof prop !== 'string' || prop.startsWith('$')) return undefined;
        return delegate(prop);
      },
    },
  );
  return client;
}

function aggregateRows(rows: Row[], args: any): Row {
  const out: Row = {};
  const num = (v: any) => (v == null ? null : Number(cmp(v)));
  if (args._sum) {
    out._sum = {};
    for (const f of Object.keys(args._sum)) {
      const vals = rows.map((r) => num(r[f])).filter((v): v is number => v != null);
      out._sum[f] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    }
  }
  if (args._max) {
    out._max = {};
    for (const f of Object.keys(args._max)) {
      const vals = rows.map((r) => r[f]).filter((v) => v != null);
      out._max[f] = vals.length ? vals.reduce((a, b) => (cmp(a) >= cmp(b) ? a : b)) : null;
    }
  }
  if (args._count) {
    out._count = args._count === true ? rows.length : Object.fromEntries(Object.keys(args._count).map((f) => [f, rows.length]));
  }
  return out;
}

/**
 * Relations of the Planwise models the access / task / message specs
 * touch. Extend per spec when a new relation filter shows up.
 */
export const PLANWISE_RELATIONS: Relations = {
  project: {
    members: { model: 'projectMember', from: 'id', to: 'projectId', many: true },
    tasks: { model: 'task', from: 'id', to: 'projectId', many: true },
    partnerRoles: { model: 'projectPartnerRole', from: 'id', to: 'projectId', many: true },
    leader: { model: 'user', from: 'leaderId', to: 'id' },
    orgUnit: { model: 'orgUnit', from: 'orgUnitId', to: 'id' },
  },
  projectMember: {
    user: { model: 'user', from: 'userId', to: 'id' },
    project: { model: 'project', from: 'projectId', to: 'id' },
  },
  projectPartnerRole: {
    party: { model: 'businessPartner', from: 'partyId', to: 'id' },
    contactParty: { model: 'businessPartner', from: 'contactPartyId', to: 'id' },
    role: { model: 'projectRoleType', from: 'roleId', to: 'id' },
    project: { model: 'project', from: 'projectId', to: 'id' },
  },
  businessPartner: {
    user: { model: 'user', from: 'id', to: 'businessPartnerId' },
    roles: { model: 'businessPartnerRole', from: 'id', to: 'businessPartnerId', many: true },
  },
  businessPartnerRole: {
    roleType: { model: 'partnerRoleType', from: 'roleTypeId', to: 'id' },
    partner: { model: 'businessPartner', from: 'businessPartnerId', to: 'id' },
  },
  user: {
    businessPartner: { model: 'businessPartner', from: 'businessPartnerId', to: 'id' },
    orgUnit: { model: 'orgUnit', from: 'orgUnitId', to: 'id' },
    role: { model: 'role', from: 'roleId', to: 'id' },
    taskAssignees: { model: 'taskAssignee', from: 'id', to: 'userId', many: true },
  },
  task: {
    project: { model: 'project', from: 'projectId', to: 'id' },
    zone: { model: 'zone', from: 'zoneId', to: 'id' },
    assignees: { model: 'taskAssignee', from: 'id', to: 'taskId', many: true },
    creator: { model: 'user', from: 'createdBy', to: 'id' },
    comments: { model: 'taskComment', from: 'id', to: 'taskId', many: true },
    timeEntries: { model: 'timeEntry', from: 'id', to: 'taskId', many: true },
  },
  taskAssignee: {
    task: { model: 'task', from: 'taskId', to: 'id' },
    user: { model: 'user', from: 'userId', to: 'id' },
  },
  message: {
    mentions: { model: 'messageMention', from: 'id', to: 'messageId', many: true },
    replies: { model: 'message', from: 'id', to: 'parentId', many: true },
    parent: { model: 'message', from: 'parentId', to: 'id' },
    author: { model: 'user', from: 'authorId', to: 'id' },
  },
  messageMention: {
    message: { model: 'message', from: 'messageId', to: 'id' },
    user: { model: 'user', from: 'userId', to: 'id' },
  },
};
