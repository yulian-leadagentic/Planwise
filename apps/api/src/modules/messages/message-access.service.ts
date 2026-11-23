import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageEntityType, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ProjectAccessService } from '../../common/services/project-access.service';

/** The caller, as the access checks need him. */
export interface MessageViewer {
  id: number;
  isAdmin: boolean;
}

/** The fields of a message the thread checks read. */
export interface ThreadRef {
  id: number;
  parentId: number | null;
  entityType: MessageEntityType;
  entityId: number;
}

const ENTITY_TYPES: readonly MessageEntityType[] = ['project', 'task', 'zone'];

/** Whether the viewer has access to an entity itself (project rule). */
export type EntityOpener = (entityType: string, entityId: number) => boolean;

function openerFrom(visible: Record<MessageEntityType, number[]>): EntityOpener {
  const sets = {
    project: new Set(visible.project),
    task: new Set(visible.task),
    zone: new Set(visible.zone),
  } as Record<string, Set<number>>;
  return (entityType, entityId) => sets[entityType]?.has(entityId) ?? false;
}

/** Validates a free-text entity type from a query string. */
export function parseEntityType(value: unknown): MessageEntityType {
  if (typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)) {
    return value as MessageEntityType;
  }
  throw new BadRequestException('entityType must be project, task or zone.');
}

/**
 * Permissions round 4 (2026-11-23): who may see a discussion thread.
 *
 * A thread is a top-level message plus its replies. The viewer sees it
 * when he has access to its entity (the project rule, through
 * ProjectAccessService) or when he is mentioned in any live message of
 * that thread. A mention opens that thread only, never the project.
 */
@Injectable()
export class MessageAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Throws unless the viewer has access to the entity itself.
   * Returns the entity's projectId (null for a personal task).
   */
  async assertEntityAccess(
    viewer: MessageViewer,
    entityType: MessageEntityType,
    entityId: number,
  ): Promise<number | null> {
    switch (entityType) {
      case 'project':
        await this.access.assertProjectAccess(viewer.id, entityId, viewer.isAdmin);
        return entityId;
      case 'task':
        return this.access.assertTaskAccess(viewer.id, entityId, viewer.isAdmin);
      case 'zone':
        return this.access.assertZoneAccess(viewer.id, entityId, viewer.isAdmin);
      default:
        throw new BadRequestException('entityType must be project, task or zone.');
    }
  }

  /** Id of the top-level message of the thread `message` belongs to. */
  async threadRootId(message: Pick<ThreadRef, 'id' | 'parentId'>): Promise<number> {
    if (message.parentId == null) return message.id;
    // Replies are one level deep; older data may hold a reply to a reply.
    const parent = await this.prisma.message.findUnique({
      where: { id: message.parentId },
      select: { id: true, parentId: true },
    });
    return parent?.parentId ?? message.parentId;
  }

  /** True when the user is mentioned in a live message of the thread. */
  async isMentionedInThread(userId: number, rootId: number): Promise<boolean> {
    const hit = await this.prisma.messageMention.findFirst({
      where: {
        userId,
        message: {
          deletedAt: null,
          OR: [{ id: rootId }, { parentId: rootId }, { parent: { parentId: rootId } }],
        },
      },
      select: { id: true },
    });
    return hit != null;
  }

  /** Root ids of every thread the user is mentioned in. */
  async mentionedThreadIds(userId: number): Promise<number[]> {
    const rows = await this.prisma.messageMention.findMany({
      where: { userId, message: { deletedAt: null } },
      select: {
        message: { select: { id: true, parentId: true, parent: { select: { parentId: true } } } },
      },
    });
    const ids = new Set<number>();
    for (const r of rows) {
      const m = r.message;
      ids.add(m.parent?.parentId ?? m.parentId ?? m.id);
    }
    return [...ids];
  }

  /**
   * Throws unless the viewer may see the thread of `message`.
   * `projectId` is set when access came through the project rule.
   */
  async assertThreadAccess(
    viewer: MessageViewer,
    message: ThreadRef,
  ): Promise<{ projectId: number | null; viaMention: boolean }> {
    try {
      const projectId = await this.assertEntityAccess(viewer, message.entityType, message.entityId);
      return { projectId, viaMention: false };
    } catch (err) {
      if (!(err instanceof ForbiddenException || err instanceof NotFoundException)) throw err;
      const rootId = await this.threadRootId(message);
      if (await this.isMentionedInThread(viewer.id, rootId)) {
        return { projectId: null, viaMention: true };
      }
      throw err;
    }
  }

  /**
   * Narrows `base` to the messages the viewer can see: the entity is
   * visible to him, or the message is in a thread he is mentioned in.
   * Only the entities `base` actually matches are resolved.
   */
  async scopeWhere(
    viewer: MessageViewer,
    base: Prisma.MessageWhereInput,
  ): Promise<Prisma.MessageWhereInput> {
    return (await this.scope(viewer, base)).where;
  }

  /**
   * scopeWhere plus `canOpen`: whether the viewer has access to a
   * matched entity itself (false = he sees it only through a mention).
   */
  async scope(
    viewer: MessageViewer,
    base: Prisma.MessageWhereInput,
  ): Promise<{ where: Prisma.MessageWhereInput; canOpen: EntityOpener }> {
    if (viewer.isAdmin) return { where: base, canOpen: () => true };

    const groups = await this.prisma.message.groupBy({
      by: ['entityType', 'entityId'],
      where: base,
    });
    const idsByType: Record<MessageEntityType, number[]> = { project: [], task: [], zone: [] };
    for (const g of groups) idsByType[g.entityType]?.push(g.entityId);

    const visible = await this.visibleEntityIds(viewer, idsByType);
    if (visible === 'all') return { where: base, canOpen: () => true };

    const or: Prisma.MessageWhereInput[] = [];
    for (const type of ENTITY_TYPES) {
      const ids = visible[type];
      if (ids.length > 0) or.push({ entityType: type, entityId: { in: ids } });
    }
    const mentioned = await this.mentionedThreadIds(viewer.id);
    if (mentioned.length > 0) {
      or.push({ id: { in: mentioned } }, { parentId: { in: mentioned } });
    }
    return {
      where: { AND: [base, or.length > 0 ? { OR: or } : { id: { in: [] } }] },
      canOpen: openerFrom(visible),
    };
  }

  /** `canOpen` for arbitrary (entityType, entityId) pairs, e.g. notification rows. */
  async entityOpener(
    viewer: MessageViewer,
    items: Array<{ entityType?: string | null; entityId?: number | null }>,
  ): Promise<EntityOpener> {
    if (viewer.isAdmin) return () => true;
    const idsByType: Record<MessageEntityType, number[]> = { project: [], task: [], zone: [] };
    for (const it of items) {
      const type = it.entityType as MessageEntityType;
      if (ENTITY_TYPES.includes(type) && it.entityId != null) idsByType[type].push(it.entityId);
    }
    const visible = await this.visibleEntityIds(viewer, idsByType);
    return visible === 'all' ? () => true : openerFrom(visible);
  }

  /**
   * Same rule as DELETE /messages/:id: the author, the leader of the
   * message's project, or an Admin.
   */
  async deletePredicate(
    viewer: MessageViewer,
    messages: Array<{ authorId: number | null; entityType: MessageEntityType; entityId: number }>,
  ): Promise<(m: { authorId: number | null; entityType: MessageEntityType; entityId: number }) => boolean> {
    if (viewer.isAdmin) return () => true;
    const own = (m: { authorId: number | null }) => m.authorId != null && m.authorId === viewer.id;

    const led = await this.prisma.project.findMany({
      where: { leaderId: viewer.id, deletedAt: null },
      select: { id: true },
    });
    if (led.length === 0) return own;
    const ledIds = new Set(led.map((p) => p.id));

    const taskIds = new Set<number>();
    const zoneIds = new Set<number>();
    for (const m of messages) {
      if (m.entityType === 'task') taskIds.add(m.entityId);
      if (m.entityType === 'zone') zoneIds.add(m.entityId);
    }
    const tasks: Array<{ id: number; projectId: number | null }> = taskIds.size
      ? await this.prisma.task.findMany({ where: { id: { in: [...taskIds] }, deletedAt: null }, select: { id: true, projectId: true } })
      : [];
    const zones: Array<{ id: number; projectId: number }> = zoneIds.size
      ? await this.prisma.zone.findMany({ where: { id: { in: [...zoneIds] }, deletedAt: null }, select: { id: true, projectId: true } })
      : [];
    const taskProject = new Map<number, number | null>(tasks.map((t) => [t.id, t.projectId]));
    const zoneProject = new Map<number, number>(zones.map((z) => [z.id, z.projectId]));
    const projectOf = (m: { entityType: MessageEntityType; entityId: number }): number | null | undefined =>
      m.entityType === 'project' ? m.entityId : m.entityType === 'task' ? taskProject.get(m.entityId) : zoneProject.get(m.entityId);

    return (m) => {
      if (own(m)) return true;
      const pid = projectOf(m);
      return pid != null && ledIds.has(pid);
    };
  }

  /**
   * Whether another user (not the caller) can see the thread: project
   * access, a mention in it, or Admin. Used before sending him content.
   */
  async userCanSeeThread(userId: number, message: ThreadRef): Promise<boolean> {
    try {
      await this.assertThreadAccess({ id: userId, isAdmin: false }, message);
      return true;
    } catch (err) {
      if (!(err instanceof ForbiddenException || err instanceof NotFoundException)) throw err;
    }
    return this.isAdminUserId(userId);
  }

  /** Same Admin rule as attachMergedPermissions: granted roles win, else the legacy role. */
  private async isAdminUserId(userId: number): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true, deletedAt: null },
      select: {
        role: { select: { name: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!user) return false;
    return user.userRoles.length > 0
      ? user.userRoles.some((ur) => ur.role.name === 'Admin')
      : user.role?.name === 'Admin';
  }

  /** Which of the given entities the viewer has access to (project rule). */
  async visibleEntityIds(
    viewer: MessageViewer,
    idsByType: Record<MessageEntityType, number[]>,
  ): Promise<Record<MessageEntityType, number[]> | 'all'> {
    const out: Record<MessageEntityType, number[]> = { project: [], task: [], zone: [] };
    const total = idsByType.project.length + idsByType.task.length + idsByType.zone.length;
    if (total === 0) return out;

    const accessible = await this.access.getAccessibleProjectIds(viewer.id, viewer.isAdmin);
    if (accessible.all) return 'all';
    const projectSet = new Set(accessible.projectIds);

    const projectIds = idsByType.project.filter((id) => projectSet.has(id));
    if (projectIds.length > 0) {
      const live = await this.prisma.project.findMany({
        where: { id: { in: projectIds }, deletedAt: null },
        select: { id: true },
      });
      out.project = live.map((p) => p.id);
    }

    if (idsByType.task.length > 0) {
      const tasks = await this.prisma.task.findMany({
        where: { id: { in: idsByType.task }, deletedAt: null },
        select: {
          id: true,
          projectId: true,
          createdBy: true,
          assignees: { where: { userId: viewer.id, deletedAt: null }, select: { id: true } },
        },
      });
      out.task = tasks
        .filter((t) =>
          t.projectId != null
            ? projectSet.has(t.projectId)
            // Personal task: its creator and assignees only.
            : t.createdBy === viewer.id || (t.assignees ?? []).length > 0,
        )
        .map((t) => t.id);
    }

    if (idsByType.zone.length > 0) {
      const zones = await this.prisma.zone.findMany({
        where: { id: { in: idsByType.zone }, deletedAt: null },
        select: { id: true, projectId: true },
      });
      out.zone = zones.filter((z) => projectSet.has(z.projectId)).map((z) => z.id);
    }

    return out;
  }

  /** True when the user is the leader of the project. */
  async isProjectLeader(userId: number, projectId: number): Promise<boolean> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, leaderId: userId, deletedAt: null },
      select: { id: true },
    });
    return project != null;
  }
}
