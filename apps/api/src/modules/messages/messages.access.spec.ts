import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import { Prisma } from '@prisma/client';

import { MessagesService } from './messages.service';
import { MessageAccessService, MessageViewer } from './message-access.service';
import { PermissionDeniedException } from '../../common/errors/permission-denied';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { NotificationsController } from '../notifications/notifications.controller';
import { socketCorsOrigins } from '../../common/ws-cors';

/**
 * Permissions round 4 (2026-11-23) — discussions are scoped to threads
 * the caller can see: project access, or a mention in that thread.
 * Prisma is an in-memory fake that evaluates the where-clauses the
 * service builds; ProjectAccessService is a fake driven by `members`.
 */

type Row = {
  id: number;
  entityType: 'project' | 'task' | 'zone';
  entityId: number;
  parentId: number | null;
  authorId: number | null;
  type: 'user' | 'system';
  content: string;
  metadata: any;
  isEdited: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Fixture ─────────────────────────────────────────────────────────────
//
// Project 10 — leader 3; members 1, 5, 6.  Project 20 — member 2.
// Task 500 is in project 10.
// Users: 1 author/member, 2 stranger to project 10, 3 leader of 10,
// 4 mentioned non-member, 5 member about to be removed, 6 plain member,
// 9 admin.

const ADMIN: MessageViewer = { id: 9, isAdmin: true };
const as = (id: number): MessageViewer => ({ id, isAdmin: false });

function makeDb() {
  const projects = [
    { id: 10, leaderId: 3, deletedAt: null as Date | null },
    { id: 20, leaderId: 50, deletedAt: null as Date | null },
  ];
  const members: Record<number, Set<number>> = { 10: new Set([1, 5, 6]), 20: new Set([2]) };
  const tasks = [{ id: 500, projectId: 10, createdBy: 1, deletedAt: null }];
  let t = 0;
  const msg = (r: Partial<Row> & Pick<Row, 'id' | 'entityType' | 'entityId'>): Row => ({
    parentId: null,
    authorId: 1,
    type: 'user',
    content: 'hello',
    metadata: null,
    isEdited: false,
    deletedAt: null,
    createdAt: new Date(2026, 0, 1, 0, t),
    updatedAt: new Date(2026, 0, 1, 0, t++),
    ...r,
  });
  const messages: Row[] = [
    msg({ id: 100, entityType: 'project', entityId: 10, content: 'hello thread A' }),
    msg({ id: 101, entityType: 'project', entityId: 10, parentId: 100, content: 'hello reply A' }),
    msg({ id: 200, entityType: 'project', entityId: 10, authorId: 5, content: 'hello thread B' }),
    msg({ id: 300, entityType: 'project', entityId: 20, authorId: 2, content: 'hello other project' }),
    msg({ id: 400, entityType: 'task', entityId: 500, content: 'hello task thread' }),
  ];
  const mentions = [
    { id: 1, messageId: 100, userId: 4 },
    { id: 2, messageId: 101, userId: 5 },
  ];
  return { projects, members, tasks, messages, mentions };
}
type Db = ReturnType<typeof makeDb>;

function scalar(actual: any, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return actual == null;
  if (typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(actual);
    if ('not' in cond) return cond.not === null ? actual != null : actual !== cond.not;
    if ('contains' in cond) return String(actual ?? '').includes(cond.contains);
    if ('path' in cond) {
      // Prisma JSON path filter on MySQL: the path is passed verbatim to
      // JSON_EXTRACT, which rejects anything not starting with `$`
      // (MySQL 3143 "Invalid JSON path expression").
      if (typeof cond.path !== 'string' || !/^\$\.\w+$/.test(cond.path)) {
        throw new Error(`MySQL 3143: Invalid JSON path expression '${cond.path}'`);
      }
      const v = actual?.[cond.path.slice(2)];
      // JSON_EXTRACT gives SQL NULL for a missing key or a NULL column.
      return cond.equals === Prisma.AnyNull ? v == null : v === cond.equals;
    }
    if ('equals' in cond) return actual == null; // metadata DbNull
  }
  return actual === cond;
}

function matchMessage(db: Db, m: Row, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    switch (k) {
      case 'AND': return (v as any[]).every((w) => matchMessage(db, m, w));
      case 'OR': return (v as any[]).some((w) => matchMessage(db, m, w));
      case 'mentions':
        return db.mentions.filter((x) => x.messageId === m.id).some((x) => matchMention(db, x, v.some));
      case 'replies':
        return db.messages.filter((r) => r.parentId === m.id).some((r) => matchMessage(db, r, v.some));
      case 'parent': {
        const p = db.messages.find((x) => x.id === m.parentId);
        return !!p && matchMessage(db, p, v);
      }
      default: return scalar((m as any)[k], v);
    }
  });
}

function matchMention(db: Db, x: { messageId: number; userId: number }, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'message') {
      const m = db.messages.find((r) => r.id === x.messageId);
      return !!m && matchMessage(db, m, v);
    }
    return scalar((x as any)[k], v);
  });
}

function makeService(db: Db) {
  let nextId = 1000;
  const withReplies = (m: Row, include: any) =>
    include?.replies
      ? { ...m, replies: db.messages.filter((r) => r.parentId === m.id && r.deletedAt == null) }
      : { ...m };
  const list = (where: any) =>
    db.messages.filter((m) => matchMessage(db, m, where)).sort((a, b) => b.id - a.id);

  const prisma: any = {
    message: {
      findFirst: jest.fn(async ({ where, include }: any) => {
        const m = list(where)[0];
        return m ? withReplies(m, include) : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => db.messages.find((m) => m.id === where.id) ?? null),
      findMany: jest.fn(async ({ where, include, select, skip = 0, take }: any) =>
        list(where).slice(skip, take != null ? skip + take : undefined).map((m) => withReplies(m, include ?? select)),
      ),
      count: jest.fn(async ({ where }: any) => list(where).length),
      groupBy: jest.fn(async ({ by, where, _count }: any) => {
        const groups = new Map<string, any>();
        for (const m of list(where)) {
          const key = by.map((k: string) => (m as any)[k]).join('|');
          const g = groups.get(key) ?? Object.fromEntries(by.map((k: string) => [k, (m as any)[k]]));
          if (_count) g._count = { entityId: (g._count?.entityId ?? 0) + 1 };
          groups.set(key, g);
        }
        return [...groups.values()];
      }),
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          id: nextId++, parentId: null, authorId: null, type: 'user', metadata: null, isEdited: false,
          deletedAt: null, createdAt: new Date(), updatedAt: new Date(), content: '', ...data,
        };
        db.messages.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = db.messages.find((m) => m.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    messageMention: {
      findFirst: jest.fn(async ({ where }: any) => db.mentions.find((x) => matchMention(db, x, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        db.mentions.filter((x) => matchMention(db, x, where)).map((x) => {
          const m = db.messages.find((r) => r.id === x.messageId)!;
          const p = db.messages.find((r) => r.id === m.parentId);
          return { message: { id: m.id, parentId: m.parentId, parent: p ? { parentId: p.parentId } : null } };
        }),
      ),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) db.mentions.push({ id: db.mentions.length + 1, ...d });
        return { count: data.length };
      }),
      count: jest.fn(async ({ where }: any) => db.mentions.filter((x) => matchMention(db, x, where)).length),
    },
    notification: { create: jest.fn(async ({ data }: any) => ({ id: nextId++, readAt: null, ...data })) },
    user: {
      findMany: jest.fn(async ({ where }: any) => where.id.in.map((id: number) => ({ id }))),
      // Admin lookup for another user (reply notifications): 9 is the Admin.
      findFirst: jest.fn(async ({ where }: any) => ({
        role: { name: 'Employee' },
        userRoles: [{ role: { name: where.id === 9 ? 'Admin' : 'Employee' } }],
      })),
    },
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        db.projects.find((p) => p.id === where.id && p.deletedAt == null && (where.leaderId == null || p.leaderId === where.leaderId)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        db.projects
          .filter((p) => (where.id ? where.id.in.includes(p.id) : true) && (where.leaderId == null || p.leaderId === where.leaderId))
          .filter((p) => p.deletedAt == null)
          .map((p) => ({ id: p.id })),
      ),
    },
    task: {
      findMany: jest.fn(async ({ where }: any) =>
        db.tasks.filter((t) => where.id.in.includes(t.id)).map((t) => ({ ...t, assignees: [] })),
      ),
    },
    zone: { findMany: jest.fn(async () => []) },
  };

  const hasAccess = (uid: number, pid: number) =>
    db.projects.find((p) => p.id === pid)?.leaderId === uid || !!db.members[pid]?.has(uid);
  const deny = () =>
    new PermissionDeniedException("You're not a member of this project.", { module: 'projects', reason: 'NOT_PROJECT_MEMBER' });
  const access: any = {
    assertProjectAccess: jest.fn(async (uid: number, pid: number, isAdmin: boolean) => {
      if (isAdmin) return;
      if (!db.projects.some((p) => p.id === pid)) throw new NotFoundException('Project not found');
      if (!hasAccess(uid, pid)) throw deny();
    }),
    assertTaskAccess: jest.fn(async (uid: number, taskId: number, isAdmin: boolean) => {
      const task = db.tasks.find((t) => t.id === taskId);
      if (!task) throw new NotFoundException('Task not found');
      if (!isAdmin && !hasAccess(uid, task.projectId)) throw deny();
      return task.projectId;
    }),
    assertZoneAccess: jest.fn(async () => {
      throw new NotFoundException('Zone not found');
    }),
    getAccessibleProjectIds: jest.fn(async (uid: number, isAdmin: boolean) =>
      isAdmin
        ? { all: true, projectIds: [] }
        : { all: false, projectIds: db.projects.filter((p) => hasAccess(uid, p.id)).map((p) => p.id) },
    ),
  };

  const emitter: any = { emit: jest.fn() };
  const msgAccess = new MessageAccessService(prisma, access);
  const svc = new MessagesService(prisma, emitter, msgAccess);
  return { svc, prisma, access, emitter };
}

const listDto = (entityType?: string, entityId?: number): any => ({
  entityType, entityId, page: 1, perPage: 50, skip: 0, take: 50,
});
const ids = (rows: any[]) => rows.map((r) => r.id).sort((a, b) => a - b);

describe('Messages — thread visibility (round 4)', () => {
  let db: Db;
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    db = makeDb();
    ctx = makeService(db);
  });

  describe('a stranger to the project', () => {
    it("cannot list the project's threads (403 NOT_PROJECT_MEMBER)", async () => {
      const err = await ctx.svc.findByEntity(listDto('project', 10), as(2)).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.details.reason).toBe('NOT_PROJECT_MEMBER');
    });

    it('cannot read a thread or its summary', async () => {
      await expect(ctx.svc.findOne(100, as(2))).rejects.toBeInstanceOf(PermissionDeniedException);
      await expect(ctx.svc.findOne(101, as(2))).rejects.toBeInstanceOf(PermissionDeniedException);
      await expect(ctx.svc.summarizeThread(100, as(2))).rejects.toBeInstanceOf(PermissionDeniedException);
    });

    it("finds none of the project's messages in search, the global list or counts", async () => {
      const found = await ctx.svc.search('hello', as(2));
      expect(ids(found.data)).toEqual([300]);
      expect(found.meta.total).toBe(1);

      const all = await ctx.svc.findByEntity(listDto(), as(2));
      expect(ids(all.data)).toEqual([300]);

      expect(await ctx.svc.countByEntities(as(2), 'task', [500])).toEqual({ 500: 0 });
    });

    it('analytics count only his visible threads', async () => {
      const a = await ctx.svc.getAnalytics(as(2));
      expect(a.totalMessages).toBe(1);
      expect(a.totalThreads).toBe(1);
      expect(a.mentionCount).toBe(0);
      expect(a.recentActivity.map((m: any) => m.id)).toEqual([300]);
    });

    it('cannot post a new thread in the project', async () => {
      await expect(
        ctx.svc.create(as(2), { entityType: 'project', entityId: 10, content: 'hi' } as any),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      expect(ctx.prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('a member', () => {
    it('sees every thread of the project and its tasks', async () => {
      const list = await ctx.svc.findByEntity(listDto('project', 10), as(6));
      expect(ids(list.data)).toEqual([100, 200]);
      const found = await ctx.svc.search('hello', as(6));
      expect(ids(found.data)).toEqual([100, 101, 200, 400]);
      expect(await ctx.svc.countByEntities(as(6), 'task', [500])).toEqual({ 500: 1 });
    });
  });

  describe('a mentioned non-member', () => {
    it('can read the thread he is mentioned in, and only that one', async () => {
      const thread = await ctx.svc.findOne(100, as(4));
      expect(thread.id).toBe(100);
      expect((thread as any).replies.map((r: any) => r.id)).toEqual([101]);
      await expect(ctx.svc.findOne(200, as(4))).rejects.toBeInstanceOf(PermissionDeniedException);

      const list = await ctx.svc.findByEntity(listDto('project', 10), as(4));
      expect(ids(list.data)).toEqual([100]);

      const found = await ctx.svc.search('hello', as(4));
      expect(ids(found.data)).toEqual([100, 101]);
    });

    it('can reply in that thread but not in another thread of the project', async () => {
      const reply = await ctx.svc.create(as(4), {
        entityType: 'project', entityId: 10, parentId: 100, content: 'my answer',
      } as any);
      expect(reply).toMatchObject({ parentId: 100, authorId: 4 });

      await expect(
        ctx.svc.create(as(4), { entityType: 'project', entityId: 10, parentId: 200, content: 'x' } as any),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      await expect(
        ctx.svc.create(as(4), { entityType: 'project', entityId: 10, content: 'new thread' } as any),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
    });

    it('a reply to a reply joins the thread (parent = thread root)', async () => {
      const reply = await ctx.svc.create(as(4), {
        entityType: 'project', entityId: 10, parentId: 101, content: 'nested',
      } as any);
      expect(reply).toMatchObject({ parentId: 100 });
    });

    it('cannot resolve or reopen the thread he is mentioned in (403 NOT_PROJECT_MEMBER)', async () => {
      for (const action of [
        () => ctx.svc.resolveThread(100, as(4)),
        () => ctx.svc.unresolveThread(100, as(4)),
      ]) {
        const err = await action().catch((e) => e);
        expect(err).toBeInstanceOf(PermissionDeniedException);
        expect(err.details.reason).toBe('NOT_PROJECT_MEMBER');
      }
      expect(ctx.prisma.message.update).not.toHaveBeenCalled();
    });

    it('a project member and an Admin still resolve and reopen', async () => {
      const resolved: any = await ctx.svc.resolveThread(100, as(6));
      expect(resolved.metadata).toMatchObject({ resolved: true, resolvedBy: 6 });
      const reopened: any = await ctx.svc.unresolveThread(100, ADMIN);
      expect(reopened.metadata).not.toHaveProperty('resolved');
    });
  });

  describe('a removed member', () => {
    it('loses the project threads in his inbox, except those he is mentioned in', async () => {
      // User 5 wrote thread 200 and is mentioned in reply 101 of thread 100.
      const before = await ctx.svc.getInbox(as(5));
      expect(ids(before.data)).toEqual([100, 200]);

      db.members[10].delete(5);

      const after = await ctx.svc.getInbox(as(5));
      expect(ids(after.data)).toEqual([100]);
      expect(after.meta.total).toBe(1);
      await expect(ctx.svc.findOne(200, as(5))).rejects.toBeInstanceOf(PermissionDeniedException);
    });
  });

  describe('replies', () => {
    it('rejects a parent from another project', async () => {
      db.members[20].add(1);
      const err = await ctx.svc
        .create(as(1), { entityType: 'project', entityId: 10, parentId: 300, content: 'x' } as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(ctx.prisma.message.create).not.toHaveBeenCalled();
    });

    it('rejects a parent that no longer exists', async () => {
      await expect(
        ctx.svc.create(as(1), { entityType: 'project', entityId: 10, parentId: 99999, content: 'x' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('is rejected for a member who is neither the author nor the leader', async () => {
      const err = await ctx.svc.remove(200, as(6)).catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.details.reason).toBe('NOT_OWNER');
      expect(db.messages.find((m) => m.id === 200)!.deletedAt).toBeNull();
    });

    it('is rejected for a stranger', async () => {
      await expect(ctx.svc.remove(200, as(2))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is allowed for the project leader', async () => {
      await expect(ctx.svc.remove(200, as(3))).resolves.toEqual({ message: 'Message deleted' });
      expect(db.messages.find((m) => m.id === 200)!.deletedAt).toBeInstanceOf(Date);
    });

    it('is allowed for the author and for an Admin', async () => {
      await ctx.svc.remove(200, as(5));
      expect(db.messages.find((m) => m.id === 200)!.deletedAt).toBeInstanceOf(Date);
      await ctx.svc.remove(400, ADMIN);
      expect(db.messages.find((m) => m.id === 400)!.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('edit', () => {
    it('stays author-only', async () => {
      const err = await ctx.svc.update(200, as(3), 'changed').catch((e) => e);
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err.details.reason).toBe('NOT_OWNER');
      await expect(ctx.svc.update(200, as(5), 'changed')).resolves.toMatchObject({ content: 'changed', isEdited: true });
    });
  });

  describe('mentions', () => {
    it('anyone may be mentioned; the notification is pushed to the bell socket', async () => {
      await ctx.svc.create(as(1), {
        entityType: 'project', entityId: 10, content: 'ping', mentionedUserIds: [2, 2, 1],
      } as any);
      expect(db.mentions.filter((m) => m.userId === 2)).toHaveLength(1);
      expect(ctx.prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(ctx.emitter.emit).toHaveBeenCalledWith(
        'notification.created',
        expect.objectContaining({ userId: 2, type: 'mention' }),
      );
    });
  });

  it('an Admin sees everything without a scope', async () => {
    const found = await ctx.svc.search('hello', ADMIN);
    expect(ids(found.data)).toEqual([100, 101, 200, 300, 400]);
    expect(ctx.access.getAccessibleProjectIds).not.toHaveBeenCalled();
  });

  it('rejects an unknown entity type', async () => {
    await expect(ctx.svc.countByEntities(as(1), 'nope', [1])).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Messages — round 4C-2 flags and reply notifications', () => {
  let db: Db;
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    db = makeDb();
    ctx = makeService(db);
  });
  const flag = (rows: any[], key: string) =>
    Object.fromEntries(rows.flatMap((m) => [[m.id, m[key]], ...(m.replies ?? []).map((r: any) => [r.id, r[key]])]));

  describe('inbox canOpenEntity', () => {
    it('is false for a thread seen only through a mention', async () => {
      const inbox = await ctx.svc.getInbox(as(4));
      expect(inbox.data.map((m: any) => [m.id, m.canOpenEntity])).toEqual([[100, false]]);
    });

    it('is true when he has access to the entity', async () => {
      const inbox = await ctx.svc.getInbox(as(1));
      expect(inbox.data.map((m: any) => [m.id, m.canOpenEntity])).toEqual([[400, true], [100, true]]);
      const admin = await ctx.svc.getInbox(ADMIN);
      expect(admin.data.every((m: any) => m.canOpenEntity === true)).toBe(true);
    });
  });

  describe('canDelete (same rule as DELETE)', () => {
    it('author: only his own messages', async () => {
      const list = await ctx.svc.findByEntity(listDto('project', 10), as(5));
      expect(flag(list.data, 'canDelete')).toEqual({ 100: false, 101: false, 200: true });
    });

    it('project leader: every message of his project, its tasks included', async () => {
      const list = await ctx.svc.findByEntity(listDto('project', 10), as(3));
      expect(flag(list.data, 'canDelete')).toEqual({ 100: true, 101: true, 200: true });
      expect((await ctx.svc.findOne(400, as(3))).canDelete).toBe(true);
    });

    it('Admin: everything', async () => {
      const list = await ctx.svc.findByEntity(listDto('project', 10), ADMIN);
      expect(flag(list.data, 'canDelete')).toEqual({ 100: true, 101: true, 200: true });
    });

    it('a member who is not the author, or a mentioned outsider: nothing', async () => {
      const list = await ctx.svc.findByEntity(listDto('project', 10), as(6));
      expect(flag(list.data, 'canDelete')).toEqual({ 100: false, 101: false, 200: false });
      const thread = await ctx.svc.findOne(100, as(4));
      expect(flag([thread], 'canDelete')).toEqual({ 100: false, 101: false });
    });
  });

  describe('reply notifications', () => {
    const replyTo200 = () =>
      ctx.svc.create(as(1), { entityType: 'project', entityId: 10, parentId: 200, content: 'reply text' } as any);
    const replyNotices = () =>
      ctx.prisma.notification.create.mock.calls.filter(([a]: any[]) => a.data.type === 'reply');

    it('reach the parent author while he can see the thread', async () => {
      await replyTo200();
      expect(replyNotices()).toHaveLength(1);
      expect(replyNotices()[0][0].data).toMatchObject({ userId: 5, body: 'reply text' });
    });

    it('are skipped for a parent author who lost access and is not mentioned', async () => {
      db.members[10].delete(5);
      await replyTo200();
      expect(replyNotices()).toHaveLength(0);
      expect(ctx.emitter.emit).not.toHaveBeenCalledWith('notification.created', expect.objectContaining({ userId: 5 }));
    });

    it('still reach an Admin author who is not a member', async () => {
      db.messages.find((m) => m.id === 200)!.authorId = 9;
      await replyTo200();
      expect(replyNotices()[0][0].data).toMatchObject({ userId: 9 });
    });
  });
});

describe('Messages — analytics unresolved threads (MySQL JSON path)', () => {
  let db: Db;
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    db = makeDb();
    ctx = makeService(db);
  });
  const jsonPaths = (where: any): string[] =>
    where && typeof where === 'object'
      ? Object.entries(where).flatMap(([k, v]) => (k === 'path' ? [v as string] : jsonPaths(v)))
      : [];
  const unresolved = async () => (await ctx.svc.getAnalytics(ADMIN)).unresolvedThreads;
  const setMeta = (id: number, metadata: any) => {
    db.messages.find((m) => m.id === id)!.metadata = metadata;
  };

  it('filters metadata with a `$.`-prefixed JSON path (bare "resolved" is MySQL error 3143)', async () => {
    await ctx.svc.getAnalytics(ADMIN);
    const paths = ctx.prisma.message.count.mock.calls.flatMap(([args]: any[]) => jsonPaths(args.where));
    expect(paths).toContain('$.resolved');
    for (const p of paths) expect(p).toMatch(/^\$\./);
  });

  it('a thread is unresolved until resolved, and again once reopened', async () => {
    // Threads 100, 200, 300, 400 — none has metadata yet.
    expect(await unresolved()).toBe(4);
    await ctx.svc.resolveThread(100, ADMIN);
    expect(await unresolved()).toBe(3);
    await ctx.svc.unresolveThread(100, ADMIN);
    expect(await unresolved()).toBe(4);
  });

  it('resolved: false / null and metadata without the key count as unresolved', async () => {
    setMeta(100, { resolved: false });
    setMeta(200, { resolved: null });
    setMeta(300, { attachments: [{ name: 'a.pdf' }] });
    setMeta(400, { resolved: true, resolvedBy: 9 });
    expect(await unresolved()).toBe(3);
  });
});

describe('NotificationsController — canOpenEntity', () => {
  it('flags discussion rows the user cannot open', async () => {
    const db = makeDb();
    const { access, prisma } = makeService(db);
    const service: any = {
      findAll: jest.fn(async () => ({
        data: [
          { id: 1, type: 'mention', entityType: 'project', entityId: 10, messageId: 100 },
          { id: 2, type: 'mention', entityType: 'project', entityId: 20, messageId: 300 },
          { id: 3, type: 'system', entityType: null, entityId: null },
        ],
        meta: { total: 3, unreadCount: 2 },
      })),
    };
    const ctrl = new NotificationsController(service, new MessageAccessService(prisma, access));
    const res = await ctrl.findAll({ id: 4, isAdmin: false });
    expect(res.data.map((n: any) => n.canOpenEntity)).toEqual([false, false, null]);
    const member = await ctrl.findAll({ id: 1, isAdmin: false });
    expect(member.data.map((n: any) => n.canOpenEntity)).toEqual([true, false, null]);
    expect(member.meta.unreadCount).toBe(2);
  });
});

describe('Notification bell socket', () => {
  it('gateway is namespace /notifications on the default Socket.IO path', () => {
    const opts = Reflect.getMetadata(GATEWAY_OPTIONS, NotificationsGateway);
    expect(opts.namespace).toBe('/notifications');
    expect(opts.path).toBeUndefined(); // → /socket.io, what the web connects to
  });

  it('CORS origins accept a comma-separated FRONTEND_URL', () => {
    expect(socketCorsOrigins('https://a.app, https://b.app')).toEqual(['https://a.app', 'https://b.app']);
    expect(socketCorsOrigins(undefined)).toEqual(['http://localhost:5173']);
  });
});
